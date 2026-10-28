import { useRef, useState } from 'react'
import type { MapFile, MapRegion, Sketch } from '@shared/schema'
import { newId } from '@shared/ids'
import { regionTemplate } from '@shared/world/maps'
import { api, describeError } from '../../api'
import { EditableText } from '../../components/EditableText'
import { useOverlays } from '../../components/overlays'
import { loadLocal, saveLocal } from '../../storage'
import { useSettings } from '../../useTheme'
import { QuickAddDialog } from '../QuickAddDialog'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import type { WorldActions } from '../useWorldActions'
import { MapCanvas } from './MapCanvas'
import { parentMapOf, sketchOf, worldMapOf } from './mapModel'
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
  const [creating, setCreating] = useState<{ region: MapRegion; name?: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importMap = useMapImport(world, record)

  const map = props.mapId ? world.view.maps.find((m) => m.id === props.mapId) : worldMapOf(world)
  const sketch = sketchOf(world)

  // Breadcrumbs: this map, the map its place sits on, and so on up to the world map.
  const trail: MapFile[] = []
  for (let m = map; m && trail.length < 8;) {
    trail.unshift(m)
    m = m.placeId ? (parentMapOf(world, m.placeId) ?? undefined) : undefined
    if (m && trail.includes(m)) break
  }

  const saveRegions = async (target: MapFile, regions: MapRegion[], label: string) => {
    const before = target.regions
    try {
      await api.invoke('map:save', { worldId, mapId: target.id, patch: { regions } })
      record({
        label,
        undo: () =>
          api.invoke('map:save', { worldId, mapId: target.id, patch: { regions: before } }),
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

  const dropPerson = async (personId: string, placeId: string) => {
    const person = world.resolve(personId)
    const place = world.resolve(placeId)
    if (!person || !place) return
    const before = person.facts
    const facts = {
      ...person.facts,
      location: [
        ...(person.facts['location'] ?? []),
        { id: newId('fact'), link: placeId, from: null },
      ],
    }
    try {
      await api.invoke('entry:save', { worldId, entryId: person.id, patch: { facts } })
      record({
        label: `${person.name} is now in ${place.name}`,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: person.id, patch: { facts: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const removeMap = async (target: MapFile) => {
    const answer = await choose(
      `Remove “${target.name}”?`,
      [{ value: 'remove', label: 'Move to trash', danger: true }],
      'Its regions go with it; the places stay. You can restore it from the trash.',
    )
    if (!answer) return
    try {
      const trashed = await api.invoke('trash:add', {
        target: { kind: 'map', worldId, mapId: target.id },
      })
      record({
        label: `Removed ${target.name}`,
        undo: () => api.invoke('trash:restore', { trashId: trashed.id }),
      })
      props.onOpenMap(null)
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
                {m.id === map.id ? (
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
                    { label: 'Remove map…', danger: true, onSelect: () => void removeMap(map) },
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
              toast('Map added. Find its regions: “Auto-detect all”, or the magic wand.')
            }
          }}
        />
      </header>

      <div className="map-body">
        {map ? (
          <MapCanvas
            world={world}
            map={map}
            editing={editing}
            territory={territory}
            lighter={settings.world.lighter}
            onSaveRegions={(regions, label) => saveRegions(map, regions, label)}
            onOpenEntry={props.onOpenEntry}
            onOpenMap={(id) => props.onOpenMap(id)}
            onCreatePlace={(region, name) => setCreating({ region, name })}
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
        {!editing && <UnplacedTray world={world} onOpenEntry={props.onOpenEntry} />}
      </div>

      {creating && map && (
        <QuickAddDialog
          templates={world.view.templates}
          existing={world.view.entries.flatMap((e) => [e.name, ...e.aliases])}
          lens="where"
          name={creating.name}
          template={regionTemplate(parentPlace?.template ?? null)}
          onCreate={async (name, template) => {
            const created = await props.actions.create(
              name,
              template,
              map.placeId
                ? { within: [{ id: newId('fact'), link: map.placeId, from: null }] }
                : undefined,
            )
            if (!created) return false
            const latest = world.view.maps.find((m) => m.id === map.id) ?? map
            await saveRegions(
              latest,
              latest.regions.map((r) =>
                r.id === creating.region.id ? { ...r, placeId: created.id } : r,
              ),
              `Linked a region to ${created.name}`,
            )
            return true
          }}
          onCancel={() => setCreating(null)}
        />
      )}
    </div>
  )
}
