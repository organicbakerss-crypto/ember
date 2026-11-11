import { useEffect, useState } from 'react'
import { isIndividual } from '@shared/world/templates'
import type { WorldView } from '@shared/ipc'
import type { AiCharacterFile } from '@shared/schema'
import { api, useIpcEvent } from '../api'
import { AiCharacterSection } from '../world/AiCharacterSection'

/**
 * Settings → AI: the writer's own story characters, world by world. Each one
 * belongs to a person in the world (the same section shows on their page).
 */
export function StoryCharactersSettings() {
  const [worlds, setWorlds] = useState<{ id: string; name: string }[] | null>(null)
  const [worldId, setWorldId] = useState<string | null>(null)
  const [view, setView] = useState<WorldView | null>(null)
  const [cast, setCast] = useState<AiCharacterFile[]>([])
  const [entryId, setEntryId] = useState<string | null>(null)

  useEffect(() => {
    api.invoke('library:snapshot').then(
      (snap) => {
        const list = snap.worlds.map((w) => ({ id: w.id, name: w.name }))
        setWorlds(list)
        setWorldId((current) => current ?? list[0]?.id ?? null)
      },
      () => setWorlds([]),
    )
  }, [])

  const load = (id: string | null) => {
    if (!id) return
    api.invoke('world:get', { worldId: id }).then(setView, () => setView(null))
    api.invoke('character:list', { worldId: id }).then(setCast, () => setCast([]))
  }
  useEffect(() => load(worldId), [worldId])
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'world' && c.worldId === worldId) load(worldId)
  })

  if (!worlds) return null
  if (!worlds.length) {
    return (
      <p className="muted small">
        Story characters come from the people in a story’s world. This library has no world yet.
      </p>
    )
  }
  const withCard = new Set(cast.map((c) => c.entryId))
  const people = (view?.entries ?? [])
    .filter((e) => isIndividual(view?.templates ?? [], e.template))
    .sort((a, b) => a.name.localeCompare(b.name))
  const chosen = people.find((e) => e.id === entryId) ?? null

  return (
    <div className="stack">
      {worlds.length > 1 && (
        <label>
          World
          <select
            value={worldId ?? ''}
            onChange={(e) => {
              setWorldId(e.target.value)
              setEntryId(null)
            }}
          >
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Story character
        <select value={entryId ?? ''} onChange={(e) => setEntryId(e.target.value || null)}>
          <option value="">Choose someone…</option>
          {people.some((p) => withCard.has(p.id)) && (
            <optgroup label="Already set up">
              {people
                .filter((p) => withCard.has(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          )}
          <optgroup label="Not set up yet">
            {people
              .filter((p) => !withCard.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        </select>
      </label>
      {chosen && worldId && (
        <AiCharacterSection
          key={chosen.id}
          worldId={worldId}
          entryId={chosen.id}
          name={chosen.name}
          heading={false}
        />
      )}
    </div>
  )
}
