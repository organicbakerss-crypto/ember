import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EntrySummary, WorldIndex, WorldView } from '@shared/ipc'
import type { Template } from '@shared/schema'
import { entryTerms } from '@shared/names'
import { chapterPositions } from '@shared/world/story'
import type { ChapterPositions } from '@shared/world/facts'
import { api, describeError, useIpcEvent } from '../api'

export interface WorldData {
  view: WorldView
  index: WorldIndex | null
  byId: Map<string, EntrySummary>
  /** Entries by id, including ids of entries merged into them. */
  resolve: (entryId: string) => EntrySummary | undefined
  templates: Map<string, Template>
  positions: ChapterPositions
  terms: ReturnType<typeof entryTerms>
}

const INDEX_DELAY_MS = 1500

/**
 * A world and its story index, kept live: entries reload when they change,
 * the index (mentions in chapters) a little after the manuscript changes.
 */
export function useWorld(worldId: string | null): { data: WorldData | null; error: string | null } {
  const [view, setView] = useState<WorldView | null>(null)
  const [index, setIndex] = useState<WorldIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadView = useCallback(() => {
    if (!worldId) return
    api.invoke('world:get', { worldId }).then(
      (v) => {
        setView(v)
        setError(null)
      },
      (err) => setError(describeError(err).message),
    )
  }, [worldId])
  const loadIndex = useCallback(() => {
    if (!worldId) return
    api.invoke('world:index', { worldId }).then(setIndex, () => {})
  }, [worldId])
  const loadIndexSoon = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(loadIndex, INDEX_DELAY_MS)
  }, [loadIndex])
  useEffect(() => {
    loadView()
    loadIndex()
    return () => clearTimeout(timer.current)
  }, [loadView, loadIndex])

  useIpcEvent('library:changed', (c) => {
    if (!worldId) return
    if ((c.kind === 'world' || c.kind === 'entry' || c.kind === 'inbox') && c.worldId === worldId) {
      loadView()
      if (c.kind !== 'inbox') loadIndexSoon()
    } else if (c.kind === 'chapter' || c.kind === 'outline' || c.kind === 'volume') {
      loadIndexSoon()
    } else if (c.kind === 'series' || c.kind === 'library') {
      loadIndex()
    }
  })

  const data = useMemo<WorldData | null>(() => {
    if (!view || view.world.id !== worldId) return null
    const byId = new Map(view.entries.map((e) => [e.id, e]))
    const merged = new Map<string, EntrySummary>()
    for (const e of view.entries) for (const old of e.mergedFrom) merged.set(old, e)
    return {
      view,
      index: index,
      byId,
      resolve: (id) => byId.get(id) ?? merged.get(id),
      templates: new Map(view.templates.map((t) => [t.id, t])),
      positions: index ? chapterPositions(index) : new Map(),
      terms: entryTerms(view.entries),
    }
  }, [view, index, worldId])

  return { data, error }
}
