import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { MapFile, MapRegion, Point } from '@shared/schema'
import { newId } from '@shared/ids'
import { labelPoint, pointInRegion, regionPath } from '@shared/world/maps'
import { describeError } from '../../api'
import { useOverlays } from '../../components/overlays'
import { worldImageUrl } from '@shared/media'
import { EntryPicker } from '../EntryPicker'
import { initials } from '../model'
import type { WorldData } from '../useWorld'
import type { Rings } from './detect'
import { detector } from './detectClient'
import { mapOfPlace, peopleAt, rulerColour, rulerOf } from './mapModel'
import { mapPixels, useMapImage, type MapPixels } from './usePixels'

export type Tool = 'select' | 'wand' | 'trace' | 'split'

const TOOL_HELP: Record<Tool, string> = {
  select:
    'Click a region to select it (Shift+click to add more). Link it to a place, merge, or delete.',
  wand: 'Click inside an area to fill just that area. Raise the tolerance for shaded maps.',
  trace: 'Click around an area to outline it. Enter or double-click finishes; Esc cancels.',
  split: 'Select one region, then click points across it to draw the cut. Enter cuts.',
}

/**
 * An image map with its regions drawn over it as vector outlines. Viewing:
 * hover shows a region's name, click opens its place, people stand where
 * they are, and regions can be tinted by who rules them. Editing: detect
 * regions (all at once or with the magic wand), trace by hand, merge and
 * split, and link each region to a place.
 */
export function MapCanvas(props: {
  world: WorldData
  map: MapFile
  editing: boolean
  territory: boolean
  lighter: boolean
  onSaveRegions: (regions: MapRegion[], label: string) => Promise<void>
  onOpenEntry: (entryId: string) => void
  onOpenMap: (mapId: string) => void
  onCreatePlace: (region: MapRegion, name?: string) => void
  onDropPerson: (personId: string, placeId: string) => void
}) {
  const { world, map } = props
  const worldId = world.view.world.id
  const { width, height } = map.image!
  const imageUrl = useMapImage(worldId, map, props.lighter)
  const svg = useRef<SVGSVGElement>(null)
  const { toast, choose } = useOverlays()
  const [tool, setTool] = useState<Tool>('select')
  const [tolerance, setTolerance] = useState(12)
  const [selected, setSelected] = useState<string[]>([])
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const [path, setPath] = useState<Point[]>([]) // trace or split points
  const [busy, setBusy] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [linking, setLinking] = useState(false)
  const pixels = useRef<MapPixels | null>(null)

  const regions = map.regions
  const byId = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions])
  const unit = Math.max(width, height) / 100 // 1% of the map, for marker sizes

  // Leaving edit mode clears the edit state.
  const [wasEditing, setWasEditing] = useState(props.editing)
  if (props.editing !== wasEditing) {
    setWasEditing(props.editing)
    setPath([])
    setTool('select')
    setLinking(false)
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

  /** Runs a detection step on the working copy of the image. */
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
  const fromWork = (rings: Rings, s: number): Point[][] =>
    rings.map((ring) => ring.map(([x, y]) => [x / s, y / s] as Point))

  const save = (next: MapRegion[], label: string) => props.onSaveRegions(next, label)

  /** Regions found by detection are added unless they cover a region that's already there. */
  const addDetected = (found: Point[][][], label: string) => {
    const fresh = found.filter(
      (rings) => !regions.some((r) => pointInRegion(labelPoint({ rings }), r)),
    )
    if (!fresh.length) {
      toast('No new regions found.')
      return
    }
    void save(
      [...regions, ...fresh.map((rings) => ({ id: newId('region'), rings, placeId: null }))],
      `${label}: ${fresh.length} ${fresh.length === 1 ? 'region' : 'regions'}`,
    )
  }

  const detectAll = async () => {
    const found = await withPixels('Finding regions…', async (px) => {
      const rings = await detector.detectAll(px.key)
      return rings.map((r) => fromWork(r, px.scale))
    })
    if (found) addDetected(found, 'Detected regions')
  }

  const regionAt = (p: Point) => regions.findLast((r) => pointInRegion(p, r))

  const onCanvasClick = async (e: React.MouseEvent) => {
    if (busy) return
    const p = toImage(e)
    const hit = regionAt(p)
    if (!props.editing) {
      if (!hit) return
      if (hit.placeId && world.resolve(hit.placeId)) props.onOpenEntry(hit.placeId)
      else {
        setSelected([hit.id])
        setLinking(true)
      }
      return
    }
    if (tool === 'select') {
      if (!hit) setSelected([])
      else if (e.shiftKey)
        setSelected((s) => (s.includes(hit.id) ? s.filter((x) => x !== hit.id) : [...s, hit.id]))
      else setSelected([hit.id])
      setLinking(false)
    } else if (tool === 'wand') {
      if (hit) {
        setSelected([hit.id])
        return
      }
      const found = await withPixels('Filling…', async (px) => {
        const rings = await detector.wand(px.key, toWork(p, px.scale), tolerance)
        return rings && fromWork(rings, px.scale)
      })
      if (found) addDetected([found], 'Added a region')
    } else {
      setPath((pts) => [...pts, p])
    }
  }

  const finishPath = async () => {
    if (tool === 'trace' && path.length >= 3) {
      await save(
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
          target.rings.map((ring) => ring.map((pt) => toWork(pt, px.scale))),
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
      await save(
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

  const merge = async () => {
    const chosen = selected.map((id) => byId.get(id)!).filter(Boolean)
    if (chosen.length < 2) return
    const merged = await withPixels('Merging…', async (px) => {
      const result = await detector.merge(
        px.key,
        chosen.map((r) => r.rings.map((ring) => ring.map((pt) => toWork(pt, px.scale)))),
      )
      return result && fromWork(result, px.scale)
    })
    if (!merged) return
    const keep = chosen.find((r) => r.placeId) ?? chosen[0]!
    await save(
      [...regions.filter((r) => !selected.includes(r.id)), { ...keep, rings: merged }],
      `Merged ${chosen.length} regions`,
    )
    setSelected([keep.id])
  }

  const remove = async () => {
    if (!selected.length) return
    await save(
      regions.filter((r) => !selected.includes(r.id)),
      selected.length === 1 ? 'Deleted a region' : `Deleted ${selected.length} regions`,
    )
    setSelected([])
  }

  const clearAll = async () => {
    const answer = await choose(
      'Remove every region from this map?',
      [{ value: 'clear', label: 'Remove regions', danger: true }],
      'The image and the places stay. You can undo this.',
    )
    if (answer) await save([], 'Removed all regions')
  }

  const link = (region: MapRegion, placeId: string | null) => {
    void save(
      regions.map((r) => (r.id === region.id ? { ...r, placeId } : r)),
      placeId
        ? `Linked a region to ${world.resolve(placeId)?.name ?? 'a place'}`
        : 'Unlinked a region',
    )
    setLinking(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!props.editing || (e.target as HTMLElement).closest('input, textarea, [role="dialog"]'))
      return
    if (e.key === 'Enter') void finishPath()
    else if (e.key === 'Escape') {
      setPath([])
      setLinking(false)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select') void remove()
    else return
    e.preventDefault()
  }

  const one = selected.length === 1 ? byId.get(selected[0]!) : undefined
  const hovered = hover ? byId.get(hover.id) : undefined
  const hoverName = hovered?.placeId ? world.resolve(hovered.placeId)?.name : undefined
  const rulers = new Map<string, EntrySummary>()
  if (props.territory) {
    for (const r of regions) {
      const ruler = r.placeId ? rulerOf(world, r.placeId) : undefined
      if (ruler) rulers.set(ruler.id, ruler)
    }
  }

  const pointerMove = (e: ReactPointerEvent) => {
    if (path.length && (tool === 'trace' || tool === 'split')) setCursor(toImage(e))
  }
  const [cursor, setCursor] = useState<Point | null>(null)

  return (
    <div className="map-canvas" tabIndex={0} onKeyDown={onKeyDown} aria-label={`Map: ${map.name}`}>
      {props.editing && (
        <div className="map-tools" role="toolbar" aria-label="Region tools">
          <div className="segmented" role="radiogroup" aria-label="Tool">
            {(['select', 'wand', 'trace', 'split'] as Tool[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={tool === t}
                className={tool === t ? 'active' : ''}
                onClick={() => {
                  setTool(t)
                  setPath([])
                }}
              >
                {{ select: 'Select', wand: 'Magic wand', trace: 'Trace', split: 'Split' }[t]}
              </button>
            ))}
          </div>
          {tool === 'wand' && (
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
          )}
          <button onClick={() => void detectAll()} disabled={!!busy}>
            Auto-detect all
          </button>
          {tool === 'select' && (
            <>
              <button onClick={() => void merge()} disabled={selected.length < 2 || !!busy}>
                Merge
              </button>
              <button onClick={() => void remove()} disabled={!selected.length}>
                Delete
              </button>
              <button onClick={() => setLinking(true)} disabled={!one}>
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
          <p className="muted small map-help">{busy ?? TOOL_HELP[tool]}</p>
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
          className={`map-svg ${props.editing ? `editing tool-${tool}` : ''}`}
          viewBox={`0 0 ${width} ${height}`}
          style={zoom === 1 ? { width: '100%', height: '100%' } : { width: `${zoom * 100}%` }}
          role="img"
          aria-label={map.name}
          onClick={(e) => void onCanvasClick(e)}
          onDoubleClick={() => tool === 'trace' && void finishPath()}
          onPointerMove={pointerMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id="map-portrait" clipPathUnits="objectBoundingBox">
              <circle cx="0.5" cy="0.5" r="0.5" />
            </clipPath>
          </defs>
          <image href={imageUrl} x={0} y={0} width={width} height={height} />
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
                onMouseMove={(e) => setHover({ id: r.id, x: e.clientX, y: e.clientY })}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-entry')) e.preventDefault()
                }}
                onDrop={(e) => {
                  const personId = e.dataTransfer.getData('application/x-entry')
                  if (!personId) return
                  e.preventDefault()
                  if (r.placeId) props.onDropPerson(personId, r.placeId)
                  else toast('Link this region to a place first.')
                }}
              />
            )
          })}
          {!props.editing &&
            regions.map((r) => {
              if (!r.placeId) return null
              const [x, y] = labelPoint(r)
              const here = peopleAt(world, r.placeId)
              const sub = mapOfPlace(world, r.placeId)
              return (
                <g key={`m-${r.id}`} className="map-markers">
                  {here.slice(0, 4).map((p, i) => {
                    const cx = x + (i - (Math.min(here.length, 4) - 1) / 2) * unit * 2.6
                    return (
                      <g
                        key={p.id}
                        className="map-person"
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onOpenEntry(p.id)
                        }}
                      >
                        <title>{p.name}</title>
                        <circle cx={cx} cy={y + unit * 1.8} r={unit * 1.2} />
                        {p.portrait ? (
                          <image
                            href={worldImageUrl(worldId, p.portrait.file)}
                            x={cx - unit * 1.1}
                            y={y + unit * 0.7}
                            width={unit * 2.2}
                            height={unit * 2.2}
                            clipPath="url(#map-portrait)"
                            preserveAspectRatio="xMidYMid slice"
                          />
                        ) : (
                          <text x={cx} y={y + unit * 2.2} fontSize={unit * 1.1} textAnchor="middle">
                            {initials(p.name)}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  {here.length > 4 && (
                    <text
                      x={x + unit * 6}
                      y={y + unit * 2.2}
                      fontSize={unit * 1.1}
                      className="map-more"
                    >
                      +{here.length - 4}
                    </text>
                  )}
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
          {path.length > 0 && (
            <polyline
              className="map-draft"
              points={[...path, ...(cursor ? [cursor] : [])].map((p) => p.join(',')).join(' ')}
              strokeWidth={unit * 0.3}
            />
          )}
        </svg>
      </div>

      {hover && !props.editing && hovered && (
        <div className="map-tooltip small" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {hoverName ?? 'Not linked to a place yet: click to link it'}
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

      {linking && one && (
        <div className="map-link-panel card" role="dialog" aria-label="Link region">
          <strong>
            {one.placeId
              ? `This region is ${world.resolve(one.placeId)?.name ?? 'a missing place'}`
              : 'Which place is this region?'}
          </strong>
          <EntryPicker
            world={world}
            lenses={['where']}
            placeholder="Find a place, or type a new name"
            onPick={(place) => link(one, place.id)}
            onCreate={(name) => {
              setLinking(false)
              props.onCreatePlace(one, name)
            }}
            onCancel={() => setLinking(false)}
          />
          <div className="row small">
            <button
              className="link"
              onClick={() => {
                setLinking(false)
                props.onCreatePlace(one)
              }}
            >
              New place…
            </button>
            {one.placeId && (
              <button className="link" onClick={() => link(one, null)}>
                Unlink
              </button>
            )}
            <span className="status-spacer" />
            <button className="link" onClick={() => setLinking(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
