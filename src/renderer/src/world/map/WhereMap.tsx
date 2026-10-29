import { useRef, useState } from 'react'
import type { EntrySummary, TrashEntry } from '@shared/ipc'
import type { FactAnchor, MapFile, MapPin, MapRegion, Point, Sketch } from '@shared/schema'
import { newId } from '@shared/ids'
import { regionTemplate, smallestRegionAt } from '@shared/world/maps'
import { currentValue, sameAnchor } from '@shared/world/facts'
import { anchorOf } from '@shared/world/timeline'
import { api, describeError } from '../../api'
import { EditableText } from '../../components/EditableText'
import { useOverlays } from '../../components/overlays'
import { loadLocal, saveLocal } from '../../storage'
import { useSettings } from '../../useTheme'
import { QuickAddDialog } from '../QuickAddDialog'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import type { WorldActions } from '../useWorldActions'
import { MapCanvas, type NewPlaceTarget } from './MapCanvas'
import { PinBar } from './PinBar'
import { baseOf, parentMapOf, shownMap, sketchOf, withinChain, worldMapOf } from './mapModel'
import { useTime } from '../time/TimeContext'
import { TimeScrubber } from '../time/TimeScrubber'
import { motionAllowed, stopShort } from '../time/timeModel'
import { TravelSketch } from './TravelSketch'
import { UnplacedTray } from './UnplacedTray'

/** Reads an image file for a new map: its bytes and size. */
export async function readMapImage(
  file: File,
): Promise<{ data: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return { data: new Uint8Array(await file.arrayBuffer()), ...size }
}

/** Creates a map from an image file and reports problems as a notice. */
export function useMapImport(world: WorldData | null, record: (step: UndoStep) => void) {
  const { toast } = useOverlays()
  return async (file: File, placeId: string | null): Promise<MapFile | null> => {
    if (!world) return null
    const worldId = world.view.world.id
    try {
      const image = await readMapImage(file)
      const place = placeId ? world.resolve(placeId) : undefined
      const map = await api.invoke('map:create', {
        worldId,
        name: place ? `Map of ${place.name}` : `${world.view.world.name} map`,
        placeId,
        image,
      })
      record({
        label: `Added ${map.name}`,
        undo: () => api.invoke('trash:add', { target: { kind: 'map', worldId, mapId: map.id } }),
      })
      return map
    } catch (err) {
      toast(`Couldn’t add that map: ${describeError(err).message}`)
      return null
    }
  }
}

/**
 * The Where lens's map: the world map (or a place's own map), or the travel
 * sketch when there is no map yet.
 */
export function WhereMap(props: {
  world: WorldData
  /** A place's map; null for the world map. */
  mapId: string | null
  actions: WorldActions
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
  onOpenMap: (mapId: string | null) => void
}) {
  const { world, record } = props
  const worldId = world.view.world.id
  const { settings } = useSettings()
  const { openMenu, toast, choose } = useOverlays()
  const [editing, setEditing] = useState(false)
  const [territory, setTerritoryState] = useState(() => loadLocal('world.territory') === 'on')
  const setTerritory = (on: boolean) => {
    setTerritoryState(on)
    saveLocal('world.territory', on ? 'on' : 'off')
  }
  const [creating, setCreating] = useState<{ target: NewPlaceTarget; name?: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importMap = useMapImport(world, record)

  const asked = props.mapId ? world.view.maps.find((m) => m.id === props.mapId) : undefined
  const base = asked ? baseOf(world, asked) : worldMapOf(world)
  // The version of the map in effect at the scrubber's moment.
  const map = base && shownMap(world, base)
  const sketch = sketchOf(world)
  const { stop } = useTime()

  // Breadcrumbs: this map, the map its place sits on, and so on up to the world map.
  const trail: MapFile[] = []
  for (let m = base; m && trail.length < 8;) {
    trail.unshift(m)
    m = m.placeId ? (parentMapOf(world, m.placeId) ?? undefined) : undefined
    if (m && trail.includes(m)) break
  }

  /** The map as it is now (the view may be a moment behind a save). */
  const latest = (target: MapFile) => world.view.maps.find((m) => m.id === target.id) ?? target

  /**
   * Saves regions and/or pins, and optionally an entry's facts in the same
   * step; one Undo puts all of it back.
   */
  const saveMap = async (
    target: MapFile,
    patch: { regions?: MapRegion[]; pins?: MapPin[] },
    label: string,
    entry?: { id: string; facts: EntrySummary['facts'] },
  ) => {
    const before = latest(target)
    const factsBefore = entry && world.resolve(entry.id)?.facts
    try {
      await api.invoke('map:save', { worldId, mapId: target.id, patch })
      if (entry) {
        await api.invoke('entry:save', {
          worldId,
          entryId: entry.id,
          patch: { facts: entry.facts },
        })
      }
      record({
        label,
        undo: async () => {
          await api.invoke('map:save', {
            worldId,
            mapId: target.id,
            patch: { regions: before.regions, pins: before.pins },
          })
          if (entry && factsBefore) {
            await api.invoke('entry:save', {
              worldId,
              entryId: entry.id,
              patch: { facts: factsBefore },
            })
          }
        },
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }
  const saveRegions = (target: MapFile, regions: MapRegion[], label: string) =>
    saveMap(target, { regions }, label)

  /** A "Within" value added to a place's facts. */
  const withWithin = (place: EntrySummary, regionPlaceId: string) => ({
    ...place.facts,
    within: [
      ...(place.facts['within'] ?? []),
      { id: newId('fact'), link: regionPlaceId, from: null },
    ],
  })

  /**
   * Pins a place at a point (or moves its pin). A pin inside a region counts
   * as within it: a place with no "Within" gets it; one within somewhere
   * else is asked about, never changed silently.
   */
  const placePin = async (target: MapFile, placeId: string, point: Point, pinId?: string) => {
    const place = world.resolve(placeId)
    if (!place) return
    const current = latest(target)
    const existing = current.pins.find((p) => p.id === pinId || p.placeId === place.id)
    const pins = existing
      ? current.pins.map((p) => (p.id === existing.id ? { ...p, x: point[0], y: point[1] } : p))
      : [...current.pins, { id: newId('pin'), placeId: place.id, x: point[0], y: point[1] }]
    const region = smallestRegionAt(
      current.regions.filter((r) => r.placeId && r.placeId !== place.id),
      point,
    )
    const regionPlace = region?.placeId ? world.resolve(region.placeId) : undefined
    const within = currentValue(place.facts['within'], null, world.positions)?.link
    const verb = existing ? 'Moved' : 'Pinned'
    let entry: { id: string; facts: EntrySummary['facts'] } | undefined
    if (regionPlace && !within) {
      entry = { id: place.id, facts: withWithin(place, regionPlace.id) }
    } else if (
      regionPlace &&
      within &&
      within !== regionPlace.id &&
      !withinChain(world, regionPlace.id).includes(within) &&
      !withinChain(world, within).includes(regionPlace.id)
    ) {
      const was = world.resolve(within)?.name ?? 'somewhere else'
      const answer = await choose(
        `${place.name} is in ${was}. You pinned it in ${regionPlace.name}.`,
        [
          { value: 'move', label: `Move it to ${regionPlace.name}`, primary: true },
          { value: 'keep', label: `Keep it in ${was}` },
        ],
        'The pin stays where you put it either way.',
      )
      if (answer === 'move') {
        const facts = { ...place.facts }
        facts['within'] = [
          ...(facts['within'] ?? []),
          { id: newId('fact'), link: regionPlace.id, from: null },
        ]
        entry = { id: place.id, facts }
      }
    }
    await saveMap(
      current,
      { pins },
      `${verb} ${place.name}${regionPlace ? ` in ${regionPlace.name}` : ''}`,
      entry,
    )
  }

  const removePin = async (target: MapFile, pinId: string) => {
    const current = latest(target)
    const pin = current.pins.find((p) => p.id === pinId)
    if (!pin) return
    await saveMap(
      current,
      { pins: current.pins.filter((p) => p.id !== pinId) },
      `Took ${world.resolve(pin.placeId)?.name ?? 'a place'} off the map`,
    )
  }

  const acceptSuggestion = async (placeId: string, regionPlaceId: string) => {
    const place = world.resolve(placeId)
    const region = world.resolve(regionPlaceId)
    if (!place || !region) return
    const before = place.facts
    try {
      await api.invoke('entry:save', {
        worldId,
        entryId: place.id,
        patch: { facts: withWithin(place, region.id) },
      })
      record({
        label: `${place.name} is within ${region.name}`,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: place.id, patch: { facts: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const saveSketch = async (next: Sketch, label: string) => {
    try {
      const target =
        sketch ??
        (await api.invoke('map:create', {
          worldId,
          name: 'Travel sketch',
          placeId: null,
          image: null,
        }))
      const before = target.sketch
      await api.invoke('map:save', { worldId, mapId: target.id, patch: { sketch: next } })
      record({
        label,
        undo: () =>
          api.invoke('map:save', { worldId, mapId: target.id, patch: { sketch: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  /**
   * Moving someone is a drag: it records where they are from the scrubber's
   * moment ("in Saltmere from Ch 8"); at "now", from the latest chapter.
   */
  const dropPerson = async (personId: string, placeId: string) => {
    const person = world.resolve(personId)
    const place = world.resolve(placeId)
    if (!person || !place) return
    const before = person.facts
    const chapters = world.index?.chapters ?? []
    const latest = chapters[chapters.length - 1]
    const from: FactAnchor | null = stop
      ? anchorOf(stop)
      : latest
        ? { kind: 'chapter', chapterId: latest.id }
        : null
    const when = stop ? stopShort(world, stop) : latest?.label
    const facts = {
      ...person.facts,
      location: [
        // A move at the same moment replaces the one recorded there.
        ...(person.facts['location'] ?? []).filter((v) => !sameAnchor(v.from, from)),
        { id: newId('fact'), link: placeId, from },
      ],
    }
    try {
      await api.invoke('entry:save', { worldId, entryId: person.id, patch: { facts } })
      record({
        label: `${person.name} is in ${place.name}${when ? ` from ${when}` : ''}`,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: person.id, patch: { facts: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  /** Removes a map with all its versions, or just one version. */
  const removeMap = async (target: MapFile) => {
    const version = !!target.versionOf
    const versions = version ? [] : world.view.maps.filter((m) => m.versionOf === target.id)
    const answer = await choose(
      version ? `Remove this version of “${target.name}”?` : `Remove “${target.name}”?`,
      [{ value: 'remove', label: 'Move to trash', danger: true }],
      version
        ? 'Earlier moments keep the map as it was before. You can restore it from the trash.'
        : `Its regions go with it${versions.length ? `, and its ${versions.length === 1 ? 'later version' : `${versions.length} later versions`}` : ''}; the places stay. You can restore it from the trash.`,
    )
    if (!answer) return
    try {
      const trashed: TrashEntry[] = []
      for (const m of [...versions, target]) {
        trashed.push(
          await api.invoke('trash:add', { target: { kind: 'map', worldId, mapId: m.id } }),
        )
      }
      record({
        label: version ? `Removed a version of ${target.name}` : `Removed ${target.name}`,
        undo: async () => {
          for (const t of trashed.reverse()) await api.invoke('trash:restore', { trashId: t.id })
        },
      })
      if (!version) props.onOpenMap(null)
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const [renaming, setRenaming] = useState(false)
  const renameMap = (target: MapFile, name: string) =>
    api.invoke('map:save', { worldId, mapId: target.id, patch: { name } })

  const parentPlace = map?.placeId ? world.resolve(map.placeId) : undefined

  return (
    <div className="where-map">
      <header className="map-head">
        <nav className="breadcrumb small" aria-label="Maps">
          {map ? (
            trail.map((m, i) => (
              <span key={m.id}>
                {i > 0 && <span className="muted"> › </span>}
                {m.id === base!.id ? (
                  <EditableText
                    className="breadcrumb-current"
                    value={m.name}
                    editing={renaming}
                    onEditingChange={setRenaming}
                    onRename={(name) => renameMap(m, name)}
                  />
                ) : (
                  <button className="link" onClick={() => props.onOpenMap(m.placeId ? m.id : null)}>
                    {m.name}
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className="breadcrumb-current">Travel sketch</span>
          )}
        </nav>
        <span className="status-spacer" />
        {map && (
          <label className="inline small">
            <input
              type="checkbox"
              checked={territory}
              onChange={(e) => setTerritory(e.target.checked)}
            />
            Territory colours
          </label>
        )}
        <button className={editing ? 'primary' : ''} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done editing' : map ? 'Edit regions' : 'Edit sketch'}
        </button>
        <button
          className="icon"
          aria-label="Map menu"
          onClick={(e) =>
            openMenu(e, [
              ...(map
                ? [
                    { label: 'Rename map', onSelect: () => setRenaming(true) },
                    ...(parentPlace
                      ? [
                          {
                            label: `Open ${parentPlace.name}`,
                            onSelect: () => props.onOpenEntry(parentPlace.id),
                          },
                        ]
                      : []),
                    ...(map.versionOf
                      ? [
                          {
                            label: 'Remove this version…',
                            danger: true,
                            onSelect: () => void removeMap(map),
                          },
                        ]
                      : []),
                    {
                      label: 'Remove map…',
                      danger: true,
                      onSelect: () => void removeMap(base!),
                    },
                  ]
                : [{ label: 'Import a map image…', onSelect: () => fileInput.current?.click() }]),
            ])
          }
        >
          ⋯
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          aria-label="Map image"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            const created = await importMap(file, null)
            if (created) {
              setEditing(true)
              toast(
                'Map added. Find its regions with “Auto-detect” (▾ picks the method), or the magic wand.',
              )
            }
          }}
        />
      </header>

      {(map || sketch) && <TimeScrubber world={world} />}
      {map?.versionOf && <VersionNote world={world} map={map} />}
      <div className="map-body">
        {map ? (
          <MapCanvas
            world={world}
            map={map}
            editing={editing}
            territory={territory}
            lighter={settings.world.lighter}
            glide={motionAllowed(settings.world)}
            trails={settings.world.trails}
            onSave={(patch, label) => saveMap(map, patch, label)}
            onOpenEntry={props.onOpenEntry}
            onOpenMap={(id) => props.onOpenMap(id)}
            onCreatePlace={(target, name) => setCreating({ target, name })}
            onPlacePin={(placeId, point, pinId) => void placePin(map, placeId, point, pinId)}
            onRemovePin={(pinId) => void removePin(map, pinId)}
            onDropPerson={(personId, placeId) => void dropPerson(personId, placeId)}
          />
        ) : (
          <div className="sketch-wrap">
            <TravelSketch
              world={world}
              sketch={sketch?.sketch ?? null}
              editing={editing}
              onSave={saveSketch}
              onOpenEntry={props.onOpenEntry}
              onDropPerson={(personId, placeId) => void dropPerson(personId, placeId)}
            />
            <div className="sketch-import">
              <button onClick={() => fileInput.current?.click()}>Import a map image…</button>
              <span className="muted small">
                A real map replaces the sketch here. Regions are found on it automatically or with
                the magic wand.
              </span>
            </div>
          </div>
        )}
        <div className="map-side">
          {map && (
            <PinBar
              world={world}
              map={map}
              onOpenEntry={props.onOpenEntry}
              onAcceptSuggestion={(placeId, regionId) => void acceptSuggestion(placeId, regionId)}
            />
          )}
          {!editing && <UnplacedTray world={world} onOpenEntry={props.onOpenEntry} />}
        </div>
      </div>

      {creating && map && (
        <QuickAddDialog
          templates={world.view.templates}
          existing={world.view.entries.flatMap((e) => [e.name, ...e.aliases])}
          lens="where"
          name={creating.name}
          template={
            'region' in creating.target
              ? regionTemplate(parentPlace?.template ?? null)
              : ['city', 'district'].includes(parentPlace?.template ?? '')
                ? 'landmark'
                : 'city'
          }
          onCreate={async (name, template) => {
            const { target } = creating
            const current = latest(map)
            // A new place is within the region it's in (a pin), or the map's place.
            const container =
              'point' in target
                ? (smallestRegionAt(
                    current.regions.filter((r) => r.placeId),
                    target.point,
                  )?.placeId ?? map.placeId)
                : map.placeId
            const created = await props.actions.create(
              name,
              template,
              container
                ? { within: [{ id: newId('fact'), link: container, from: null }] }
                : undefined,
            )
            if (!created) return false
            if ('region' in target) {
              await saveRegions(
                current,
                current.regions.map((r) =>
                  r.id === target.region.id ? { ...r, placeId: created.id } : r,
                ),
                `Linked a region to ${created.name}`,
              )
            } else {
              await saveMap(
                current,
                {
                  pins: [
                    ...current.pins,
                    {
                      id: newId('pin'),
                      placeId: created.id,
                      x: target.point[0],
                      y: target.point[1],
                    },
                  ],
                },
                `Pinned ${created.name}`,
              )
            }
            return true
          }}
          onCancel={() => setCreating(null)}
        />
      )}
    </div>
  )
}

/** Says which version of a map is shown, and from when. */
function VersionNote(props: { world: WorldData; map: MapFile }) {
  const { world, map } = props
  const from = map.from
  const name =
    from?.kind === 'event'
      ? world.resolve(from.entryId)?.name
      : world.index?.chapters.find((c) => c.id === from?.chapterId)?.label
  return (
    <p className="map-version-note small muted" role="note">
      The map as it is from {name ?? 'a later moment'} on. Earlier moments show it as it was; edits
      here change only this version.
    </p>
  )
}
