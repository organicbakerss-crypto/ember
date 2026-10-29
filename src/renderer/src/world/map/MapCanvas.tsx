import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { MapFile, MapPin, MapRegion, Point } from '@shared/schema'
import { newId } from '@shared/ids'
import { labelPoint, pointInRegion, regionPath, smallestRegionAt } from '@shared/world/maps'
import { describeError } from '../../api'
import { useOverlays, type MenuItem } from '../../components/overlays'
import { EntryPicker } from '../EntryPicker'
import { templateName } from '../model'
import type { WorldData } from '../useWorld'
import type { Method, Rings } from './detect'
import { detector } from './detectClient'
import { mapOfPlace, pinColour, rulerColour, rulerOf } from './mapModel'
import { MapPeople } from './MapPeople'
import { PLACE_PIN_DRAG } from './PinBar'
import { mapPixels, useMapImage, type MapPixels } from './usePixels'

export type Tool = 'select' | 'wand' | 'trace' | 'split' | 'pin'

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  wand: 'Magic wand',
  trace: 'Trace',
  split: 'Split',
  pin: 'Pin',
}

const TOOL_HELP: Record<Tool, string> = {
  select:
    'Click a region or pin to select it; Shift, Ctrl or ⌘+click adds more; drag a box to select several.',
  wand: 'Click an area to preview it. Shift+click adds to it, Alt+click cuts from it. Enter adds the region.',
  trace: 'Click around an area to outline it. Enter or double-click finishes; Esc cancels.',
  split: 'Select one region, then click points across it to draw the cut. Enter cuts.',
  pin: 'Click where a place is to pin it (inside a region or anywhere). Or drag one from the pin bar.',
}

const METHOD_LABELS: Record<Method, string> = {
  borders: 'border lines',
  landSea: 'land and sea',
  colours: 'colour areas',
}

const DEFAULT_TOLERANCE = 25

type WandOp = { point: Point; mode: 'new' | 'add' | 'subtract' }
type Hover = { kind: 'region' | 'pin'; id: string; x: number; y: number }
export type NewPlaceTarget = { region: MapRegion } | { point: Point }

/**
 * An image map with its regions (vector outlines) and pins drawn over it.
 * Viewing: hover shows a name, click opens the place, people stand where they
 * are, regions can be tinted by who rules them, and pins can be dragged
 * (back into the pin bar takes them off the map). Editing: detect regions,
 * fill them with the magic wand, trace, merge and split, drop pins, and link
 * each to a place.
 */
export function MapCanvas(props: {
  world: WorldData
  map: MapFile
  editing: boolean
  territory: boolean
  /** Portraits glide to new places as the moment changes. */
  glide: boolean
  /** Faint trails behind people who just moved. */
  trails: boolean
  lighter: boolean
  onSave: (patch: { regions?: MapRegion[]; pins?: MapPin[] }, label: string) => Promise<void>
  onOpenEntry: (entryId: string) => void
  onOpenMap: (mapId: string) => void
  onCreatePlace: (target: NewPlaceTarget, name?: string) => void
  /** Pins a place at a point (or moves its pin). */
  onPlacePin: (placeId: string, point: Point, pinId?: string) => void
  onRemovePin: (pinId: string) => void
  onDropPerson: (personId: string, placeId: string) => void
}) {
  const { world, map } = props
  const worldId = world.view.world.id
  const { width, height } = map.image!
  const imageUrl = useMapImage(worldId, map, props.lighter)
  const svg = useRef<SVGSVGElement>(null)
  const { toast, choose, openMenu } = useOverlays()
  const [tool, setTool] = useState<Tool>('select')
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const [selected, setSelected] = useState<string[]>([])
  const [hover, setHover] = useState<Hover | null>(null)
  const [path, setPath] = useState<Point[]>([]) // trace or split points
  const [cursor, setCursor] = useState<Point | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [linking, setLinking] = useState<
    { kind: 'region'; regionId: string } | { kind: 'pin'; point: Point } | null
  >(null)
  const [pickingSea, setPickingSea] = useState(false)
  const [wand, setWand] = useState<{ ops: WandOp[]; rings: Rings | null } | null>(null)
  const [box, setBox] = useState<{ from: Point; to: Point; screen: Point } | null>(null)
  // A portrait being dragged to another place (records a move at the scrubber's moment).
  const [personDrag, setPersonDrag] = useState<{
    id: string
    at: Point
    screen: Point
    moved: boolean
  } | null>(null)
  const [drag, setDrag] = useState<{
    pin: MapPin
    at: Point
    screen: Point
    moved: boolean
  } | null>(null)
  const pixels = useRef<MapPixels | null>(null)
  const swallowClick = useRef(false)

  const { regions, pins } = map
  const byId = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions])
  const unit = Math.max(width, height) / 100 // 1% of the map, for marker sizes
  const s = unit * 1.3 // pin size

  // Leaving edit mode clears the edit state.
  const [wasEditing, setWasEditing] = useState(props.editing)
  if (props.editing !== wasEditing) {
    setWasEditing(props.editing)
    setPath([])
    setTool('select')
    setLinking(null)
    setWand(null)
    setPickingSea(false)
    if (!props.editing) setSelected([])
  }

  const toImage = (e: { clientX: number; clientY: number }): Point => {
    const el = svg.current!
    const pt = el.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse())
    return [Math.max(0, Math.min(width, p.x)), Math.max(0, Math.min(height, p.y))]
  }

  /** Runs a detection step on the working copy of the image. Errors become a notice. */
  const withPixels = async <T,>(label: string, run: (px: MapPixels) => Promise<T>) => {
    setBusy(label)
    try {
      pixels.current ??= await mapPixels(worldId, map)
      await detector.load(pixels.current.key, pixels.current.pixels)
      return await run(pixels.current)
    } catch (err) {
      toast(describeError(err).message)
      return null
    } finally {
      setBusy(null)
    }
  }
  const toWork = (p: Point, s: number): Point => [p[0] * s, p[1] * s]
  const ringsToWork = (rings: Rings, s: number): Rings =>
    rings.map((ring) => ring.map((pt) => toWork(pt, s)))
  const fromWork = (rings: Rings, s: number): Rings =>
    rings.map((ring) => ring.map(([x, y]) => [x / s, y / s] as Point))

  const saveRegions = (next: MapRegion[], label: string) => props.onSave({ regions: next }, label)

  /* ---------- detection ---------- */

  /** Regions found by detection are added unless they cover a region that's already there. */
  const addDetected = (found: Rings[], how: string) => {
    const fresh = found.filter(
      (rings) => !regions.some((r) => pointInRegion(labelPoint({ rings }), r)),
    )
    if (!fresh.length) {
      toast(`No new regions found (${how}). Try another method from the ▾ menu, or the magic wand.`)
      return
    }
    void saveRegions(
      [...regions, ...fresh.map((rings) => ({ id: newId('region'), rings, placeId: null }))],
      `Found ${fresh.length} ${fresh.length === 1 ? 'region' : 'regions'} (${how})`,
    )
  }

  const runDetect = async (method: Method | 'auto', seaPoint?: Point) => {
    const found = await withPixels(
      'Finding regions… (the first time also prepares the image)',
      async (px) => {
        const result = await detector.detect(px.key, method, seaPoint && toWork(seaPoint, px.scale))
        return { method: result.method, regions: result.regions.map((r) => fromWork(r, px.scale)) }
      },
    )
    if (found) addDetected(found.regions, METHOD_LABELS[found.method])
  }

  const detectMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Automatic (pick the best method)', onSelect: () => void runDetect('auto') },
      { label: 'Border lines (political maps)', onSelect: () => void runDetect('borders') },
      { label: 'Land and sea (painted maps)', onSelect: () => void runDetect('landSea') },
      {
        label: 'Land and sea: I’ll click the sea…',
        onSelect: () => {
          setPickingSea(true)
          toast('Click anywhere in the sea.')
        },
      },
      {
        label: 'Colour areas (countries in different colours)',
        onSelect: () => void runDetect('colours'),
      },
    ] satisfies MenuItem[])

  /* ---------- the magic wand: preview, add, cut ---------- */

  const runWand = async (ops: WandOp[], tol: number) => {
    const rings = await withPixels('Filling…', async (px) => {
      let shape: Rings | null = null
      for (const op of ops) {
        const base = shape && op.mode !== 'new' ? { rings: shape, mode: op.mode } : undefined
        shape = await detector.wand(px.key, toWork(op.point, px.scale), tol, base)
        if (!shape && op.mode !== 'subtract') break
      }
      return shape && fromWork(shape, px.scale)
    })
    setWand({ ops, rings })
  }
  // Moving the tolerance slider re-runs the preview.
  const wandOps = wand?.ops
  useEffect(() => {
    if (!wandOps) return
    const t = setTimeout(() => void runWand(wandOps, tolerance), 250)
    return () => clearTimeout(t)
    // Only the tolerance re-runs it; clicks run it themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tolerance])

  const acceptWand = async () => {
    if (!wand?.rings) return
    await saveRegions(
      [...regions, { id: newId('region'), rings: wand.rings, placeId: null }],
      'Added a region',
    )
    setWand(null)
  }

  /* ---------- clicks ---------- */

  // A pin's point is its tip; its round head sits above it.
  const pinAt = (p: Point) =>
    pins.findLast((pin) => Math.hypot(pin.x - p[0], pin.y - 1.9 * s - p[1]) < s * 1.4)
  const regionAt = (p: Point) => smallestRegionAt(regions, p)
  /** Shift, Ctrl or ⌘ adds to the selection. */
  const additive = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
    e.shiftKey || e.ctrlKey || e.metaKey

  const onCanvasClick = async (e: React.MouseEvent) => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    if (busy) return
    const p = toImage(e)
    if (pickingSea) {
      setPickingSea(false)
      await runDetect('landSea', p)
      return
    }
    const hit = regionAt(p)
    if (!props.editing) {
      if (!hit) return
      if (hit.placeId && world.resolve(hit.placeId)) props.onOpenEntry(hit.placeId)
      else {
        setSelected([hit.id])
        setLinking({ kind: 'region', regionId: hit.id })
      }
      return
    }
    if (tool === 'select') {
      const target = pinAt(p)?.id ?? hit?.id
      setLinking(null)
      if (!target) {
        if (!additive(e)) setSelected([])
      } else if (additive(e))
        setSelected((s) => (s.includes(target) ? s.filter((x) => x !== target) : [...s, target]))
      else setSelected([target])
    } else if (tool === 'wand') {
      const mode: WandOp['mode'] =
        wand?.rings && e.altKey ? 'subtract' : wand?.rings && additive(e) ? 'add' : 'new'
      await runWand(
        mode === 'new' ? [{ point: p, mode }] : [...wand!.ops, { point: p, mode }],
        tolerance,
      )
    } else if (tool === 'pin') {
      setLinking({ kind: 'pin', point: p })
    } else {
      setPath((pts) => [...pts, p])
    }
  }

  /* ---------- box select and pin dragging ---------- */

  const onPointerDown = (e: React.PointerEvent) => {
    if (!props.editing || tool !== 'select' || e.button !== 0) return
    const p = toImage(e)
    if (pinAt(p)) return
    // Keep the drag even if it ends outside the map (or over a notice).
    svg.current?.setPointerCapture(e.pointerId)
    setBox({ from: p, to: p, screen: [e.clientX, e.clientY] })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toImage(e)
    if (path.length && (tool === 'trace' || tool === 'split')) setCursor(p)
    if (box) setBox({ ...box, to: p })
    if (drag) {
      const moved =
        drag.moved || Math.hypot(e.clientX - drag.screen[0], e.clientY - drag.screen[1]) > 4
      setDrag({ ...drag, at: p, moved })
    }
    if (personDrag) {
      const moved =
        personDrag.moved ||
        Math.hypot(e.clientX - personDrag.screen[0], e.clientY - personDrag.screen[1]) > 4
      setPersonDrag({ ...personDrag, at: p, moved })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (personDrag) {
      const { id, at, moved } = personDrag
      setPersonDrag(null)
      swallowClick.current = true
      if (!moved) props.onOpenEntry(id)
      else {
        const placeId =
          pinAt(at)?.placeId ??
          smallestRegionAt(
            regions.filter((r) => r.placeId),
            at,
          )?.placeId
        if (placeId) props.onDropPerson(id, placeId)
        else toast('Drop them on a place (a linked region or a pin).')
      }
    }
    if (box) {
      const far = Math.hypot(e.clientX - box.screen[0], e.clientY - box.screen[1]) > 6
      setBox(null)
      if (far) {
        swallowClick.current = true
        const [x1, x2] = [box.from[0], box.to[0]].sort((a, b) => a - b)
        const [y1, y2] = [box.from[1], box.to[1]].sort((a, b) => a - b)
        const within = ([x, y]: Point) => x >= x1! && x <= x2! && y >= y1! && y <= y2!
        const found = [
          ...regions.filter((r) => within(labelPoint(r))).map((r) => r.id),
          ...pins.filter((pin) => within([pin.x, pin.y])).map((pin) => pin.id),
        ]
        setSelected((s) => (additive(e) ? [...new Set([...s, ...found])] : found))
      }
    }
    if (drag) {
      const { pin, at, moved } = drag
      setDrag(null)
      swallowClick.current = true
      const overBar = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pin-bar')
      if (overBar) props.onRemovePin(pin.id)
      else if (moved) props.onPlacePin(pin.placeId, at, pin.id)
      else if (!props.editing) props.onOpenEntry(pin.placeId)
      else if (tool === 'select')
        setSelected((s) =>
          e.shiftKey || e.ctrlKey || e.metaKey ? [...new Set([...s, pin.id])] : [pin.id],
        )
    }
  }

  /* ---------- editing actions ---------- */

  const finishPath = async () => {
    if (tool === 'trace' && path.length >= 3) {
      await saveRegions(
        [...regions, { id: newId('region'), rings: [path], placeId: null }],
        'Traced a region',
      )
      setPath([])
    } else if (tool === 'split' && path.length >= 2) {
      const target = selected.length === 1 ? byId.get(selected[0]!) : undefined
      if (!target) {
        toast('Select one region to split first.')
        return
      }
      const pieces = await withPixels('Splitting…', async (px) => {
        const result = await detector.split(
          px.key,
          ringsToWork(target.rings, px.scale),
          path.map((pt) => toWork(pt, px.scale)),
        )
        return result && result.map((r) => fromWork(r, px.scale))
      })
      setPath([])
      if (!pieces) {
        toast('That line doesn’t cut the region in two. Draw it all the way across.')
        return
      }
      // The largest piece keeps the region's place; the others are new.
      const [first, ...rest] = pieces
      await saveRegions(
        [
          ...regions.filter((r) => r.id !== target.id),
          { ...target, rings: first! },
          ...rest.map((rings) => ({ id: newId('region'), rings, placeId: null })),
        ],
        'Split a region',
      )
      setSelected([target.id])
    }
  }

  const selectedRegions = selected.map((id) => byId.get(id)).filter((r): r is MapRegion => !!r)
  const selectedPins = pins.filter((p) => selected.includes(p.id))

  const merge = async () => {
    if (selectedRegions.length < 2) return
    const merged = await withPixels('Merging…', async (px) => {
      const result = await detector.merge(
        px.key,
        selectedRegions.map((r) => ringsToWork(r.rings, px.scale)),
      )
      return result && fromWork(result, px.scale)
    })
    if (!merged) return
    const keep = selectedRegions.find((r) => r.placeId) ?? selectedRegions[0]!
    await saveRegions(
      [...regions.filter((r) => !selected.includes(r.id)), { ...keep, rings: merged }],
      `Merged ${selectedRegions.length} regions`,
    )
    setSelected([keep.id])
  }

  const remove = async () => {
    if (!selected.length) return
    const n = selected.length
    await props.onSave(
      {
        regions: regions.filter((r) => !selected.includes(r.id)),
        pins: pins.filter((p) => !selected.includes(p.id)),
      },
      n === 1 ? 'Removed one from the map' : `Removed ${n} from the map`,
    )
    setSelected([])
  }

  const clearAll = async () => {
    const answer = await choose(
      'Remove every region from this map?',
      [{ value: 'clear', label: 'Remove regions', danger: true }],
      'The image, the pins and the places stay. You can undo this.',
    )
    if (answer) await saveRegions([], 'Removed all regions')
  }

  const link = (region: MapRegion, placeId: string | null) => {
    void saveRegions(
      regions.map((r) => (r.id === region.id ? { ...r, placeId } : r)),
      placeId
        ? `Linked a region to ${world.resolve(placeId)?.name ?? 'a place'}`
        : 'Unlinked a region',
    )
    setLinking(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!props.editing || (e.target as HTMLElement).closest('input, textarea, [role="dialog"]'))
      return
    if (e.key === 'Enter') {
      if (tool === 'wand' && wand?.rings) void acceptWand()
      else void finishPath()
    } else if (e.key === 'Escape') {
      setPath([])
      setLinking(null)
      setWand(null)
      setPickingSea(false)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select') void remove()
    else return
    e.preventDefault()
  }

  /* ---------- drawing ---------- */

  const linkRegion = linking?.kind === 'region' ? byId.get(linking.regionId) : undefined
  const hoverName = (() => {
    if (!hover) return null
    if (hover.kind === 'pin') {
      const pin = pins.find((p) => p.id === hover.id)
      const place = pin && world.resolve(pin.placeId)
      return place ? `${place.name} · ${templateName(world, place.template)}` : 'A missing place'
    }
    const r = byId.get(hover.id)
    return r?.placeId
      ? (world.resolve(r.placeId)?.name ?? 'A missing place')
      : 'Not linked to a place yet: click to link it'
  })()
  const rulers = new Map<string, EntrySummary>()
  if (props.territory) {
    for (const r of regions) {
      const ruler = r.placeId ? rulerOf(world, r.placeId) : undefined
      if (ruler) rulers.set(ruler.id, ruler)
    }
  }

  const dropPerson = (placeId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-entry')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      const personId = e.dataTransfer.getData('application/x-entry')
      if (!personId) return
      e.preventDefault()
      e.stopPropagation()
      if (placeId) props.onDropPerson(personId, placeId)
      else toast('Link this region to a place first.')
    },
  })

  const pinShape = `M0,0 C${-0.6 * s},${-0.9 * s} ${-s},${-1.3 * s} ${-s},${-1.9 * s} A${s},${s} 0 1 1 ${s},${-1.9 * s} C${s},${-1.3 * s} ${0.6 * s},${-0.9 * s} 0,0Z`

  return (
    <div className="map-canvas" tabIndex={0} onKeyDown={onKeyDown} aria-label={`Map: ${map.name}`}>
      {props.editing && (
        <div className="map-tools" role="toolbar" aria-label="Map tools">
          <div className="segmented" role="radiogroup" aria-label="Tool">
            {(['select', 'wand', 'trace', 'split', 'pin'] as Tool[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={tool === t}
                className={tool === t ? 'active' : ''}
                onClick={() => {
                  setTool(t)
                  setPath([])
                  setWand(null)
                  setLinking(null)
                }}
              >
                {TOOL_LABELS[t]}
              </button>
            ))}
          </div>
          <span className="split-button">
            <button onClick={() => void runDetect('auto')} disabled={!!busy}>
              Auto-detect
            </button>
            <button aria-label="Detection method" onClick={detectMenu} disabled={!!busy}>
              ▾
            </button>
          </span>
          {tool === 'wand' && (
            <>
              <label className="inline small">
                Tolerance
                <input
                  type="range"
                  min={1}
                  max={60}
                  value={tolerance}
                  aria-label="Tolerance"
                  onChange={(e) => setTolerance(Number(e.target.value))}
                />
                <span>{tolerance}</span>
              </label>
              {wand && (
                <>
                  <button
                    className="primary"
                    onClick={() => void acceptWand()}
                    disabled={!wand.rings || !!busy}
                  >
                    Add region
                  </button>
                  <button onClick={() => setWand(null)}>Cancel</button>
                </>
              )}
            </>
          )}
          {tool === 'select' && (
            <>
              <span className="muted small selection-count" aria-live="polite">
                {selected.length === 0
                  ? 'Nothing selected'
                  : `${selected.length} selected${selectedPins.length ? ` (${selectedPins.length} ${selectedPins.length === 1 ? 'pin' : 'pins'})` : ''}`}
              </span>
              <button onClick={() => void merge()} disabled={selectedRegions.length < 2 || !!busy}>
                Merge
              </button>
              <button onClick={() => void remove()} disabled={!selected.length}>
                Delete
              </button>
              <button
                onClick={() =>
                  selectedRegions[0] &&
                  setLinking({ kind: 'region', regionId: selectedRegions[0].id })
                }
                disabled={selectedRegions.length !== 1}
              >
                Link to a place…
              </button>
            </>
          )}
          {(tool === 'trace' || tool === 'split') && path.length > 0 && (
            <>
              <button className="primary" onClick={() => void finishPath()}>
                {tool === 'trace' ? 'Finish outline' : 'Cut'}
              </button>
              <button onClick={() => setPath([])}>Cancel</button>
            </>
          )}
          <span className="status-spacer" />
          {regions.length > 0 && (
            <button className="link small" onClick={() => void clearAll()}>
              Remove all regions
            </button>
          )}
          <p className="muted small map-help" role="status">
            {busy ?? (pickingSea ? 'Click anywhere in the sea.' : TOOL_HELP[tool])}
          </p>
        </div>
      )}

      <div className="map-zoom">
        <button
          className="icon"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(6, z * 1.5))}
        >
          +
        </button>
        <button
          className="icon"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
        >
          −
        </button>
      </div>

      <div className="map-scroll">
        <svg
          ref={svg}
          className={`map-svg ${props.editing ? `editing tool-${tool}` : ''} ${pickingSea ? 'picking' : ''}`}
          viewBox={`0 0 ${width} ${height}`}
          style={zoom === 1 ? { width: '100%', height: '100%' } : { width: `${zoom * 100}%` }}
          role="img"
          aria-label={map.name}
          onClick={(e) => void onCanvasClick(e)}
          onDoubleClick={() => tool === 'trace' && void finishPath()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onMouseLeave={() => setHover(null)}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(PLACE_PIN_DRAG)) e.preventDefault()
          }}
          onDrop={(e) => {
            const placeId = e.dataTransfer.getData(PLACE_PIN_DRAG)
            if (!placeId) return
            e.preventDefault()
            props.onPlacePin(placeId, toImage(e))
          }}
        >
          <defs>
            <clipPath id="map-portrait" clipPathUnits="objectBoundingBox">
              <circle cx="0.5" cy="0.5" r="0.5" />
            </clipPath>
          </defs>
          <image href={imageUrl} x={0} y={0} width={width} height={height} />
          {/* A dark halo under each outline keeps it visible on any map. */}
          {props.editing &&
            regions.map((r) => (
              <path
                key={`h-${r.id}`}
                d={regionPath(r)}
                className="map-region-halo"
                fillRule="evenodd"
              />
            ))}
          {regions.map((r) => {
            const ruler = props.territory && r.placeId ? rulerOf(world, r.placeId) : undefined
            const classes = [
              'map-region',
              r.placeId ? 'linked' : 'unlinked',
              selected.includes(r.id) ? 'selected' : '',
              hover?.id === r.id ? 'hover' : '',
            ].join(' ')
            return (
              <path
                key={r.id}
                d={regionPath(r)}
                className={classes}
                fillRule="evenodd"
                style={ruler ? { fill: rulerColour(ruler.id) } : undefined}
                data-region={r.id}
                aria-label={r.placeId ? world.resolve(r.placeId)?.name : 'Unlinked region'}
                onMouseMove={(e) =>
                  setHover({ kind: 'region', id: r.id, x: e.clientX, y: e.clientY })
                }
                {...dropPerson(r.placeId)}
              />
            )
          })}
          {!props.editing &&
            regions.map((r) => {
              if (!r.placeId) return null
              const [x, y] = labelPoint(r)
              const sub = mapOfPlace(world, r.placeId)
              return (
                <g key={`m-${r.id}`}>
                  {sub && (
                    <g
                      className="map-enter"
                      role="button"
                      aria-label={`Open the map of ${world.resolve(r.placeId)?.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onOpenMap(sub.id)
                      }}
                    >
                      <title>Open its map</title>
                      <circle cx={x} cy={y - unit * 1.5} r={unit * 1.2} />
                      <text x={x} y={y - unit * 1.05} fontSize={unit * 1.3} textAnchor="middle">
                        ⤵
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
          {pins.map((pin) => {
            const place = world.resolve(pin.placeId)
            const at: Point = drag?.pin.id === pin.id && drag.moved ? drag.at : [pin.x, pin.y]
            return (
              <g key={pin.id}>
                <g
                  className={`map-pin ${selected.includes(pin.id) ? 'selected' : ''} ${place ? '' : 'missing'}`}
                  transform={`translate(${at[0]} ${at[1]})`}
                  role="button"
                  aria-label={place?.name ?? 'Missing place'}
                  data-pin={pin.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || (props.editing && tool !== 'select')) return
                    e.stopPropagation()
                    svg.current?.setPointerCapture(e.pointerId)
                    setDrag({
                      pin,
                      at: [pin.x, pin.y],
                      screen: [e.clientX, e.clientY],
                      moved: false,
                    })
                  }}
                  onMouseMove={(e) => {
                    e.stopPropagation()
                    setHover({ kind: 'pin', id: pin.id, x: e.clientX, y: e.clientY })
                  }}
                  {...dropPerson(pin.placeId)}
                >
                  <path
                    d={pinShape}
                    style={{ fill: place ? pinColour(place.template) : 'var(--muted)' }}
                  />
                  <circle cx={0} cy={-1.9 * s} r={0.4 * s} className="map-pin-eye" />
                </g>
              </g>
            )
          })}
          {!props.editing && (
            <MapPeople
              world={world}
              regions={regions}
              pins={pins}
              unit={unit}
              s={s}
              hidePlace={drag?.moved ? drag.pin.placeId : undefined}
              glide={props.glide}
              trails={props.trails}
              dragging={personDrag?.moved ? personDrag : undefined}
              onPersonDown={(id, e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                svg.current?.setPointerCapture(e.pointerId)
                setPersonDrag({ id, at: toImage(e), screen: [e.clientX, e.clientY], moved: false })
              }}
              onOpenEntry={props.onOpenEntry}
            />
          )}
          {wand?.rings && (
            <path
              className="map-preview"
              d={regionPath({ rings: wand.rings })}
              fillRule="evenodd"
            />
          )}
          {path.length > 0 && (
            <polyline
              className="map-draft"
              points={[...path, ...(cursor ? [cursor] : [])].map((p) => p.join(',')).join(' ')}
              strokeWidth={unit * 0.3}
            />
          )}
          {box && (
            <rect
              className="map-box"
              x={Math.min(box.from[0], box.to[0])}
              y={Math.min(box.from[1], box.to[1])}
              width={Math.abs(box.to[0] - box.from[0])}
              height={Math.abs(box.to[1] - box.from[1])}
            />
          )}
        </svg>
      </div>

      {hover && hoverName && !drag && !(props.editing && hover.kind === 'region') && (
        <div className="map-tooltip small" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {hoverName}
        </div>
      )}

      {props.territory && rulers.size > 0 && (
        <ul className="map-legend small" aria-label="Territory">
          {[...rulers.values()].map((r) => (
            <li key={r.id}>
              <span className="swatch" style={{ background: rulerColour(r.id) }} />
              {r.name}
            </li>
          ))}
        </ul>
      )}

      {linking && (linking.kind === 'pin' || linkRegion) && (
        <div
          className="map-link-panel card"
          role="dialog"
          aria-label={linking.kind === 'pin' ? 'Pin a place' : 'Link region'}
        >
          <strong>
            {linking.kind === 'pin'
              ? 'Which place is here?'
              : linkRegion?.placeId
                ? `This region is ${world.resolve(linkRegion.placeId)?.name ?? 'a missing place'}`
                : 'Which place is this region?'}
          </strong>
          <EntryPicker
            world={world}
            lenses={['where']}
            placeholder="Find a place, or type a new name"
            onPick={(place) => {
              if (linking.kind === 'pin') {
                props.onPlacePin(place.id, linking.point)
                setLinking(null)
              } else link(linkRegion!, place.id)
            }}
            onCreate={(name) => {
              setLinking(null)
              props.onCreatePlace(
                linking.kind === 'pin' ? { point: linking.point } : { region: linkRegion! },
                name,
              )
            }}
            onCancel={() => setLinking(null)}
          />
          <div className="row small">
            {linking.kind === 'region' && linkRegion?.placeId && (
              <button className="link" onClick={() => link(linkRegion, null)}>
                Unlink
              </button>
            )}
            <span className="status-spacer" />
            <button className="link" onClick={() => setLinking(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
