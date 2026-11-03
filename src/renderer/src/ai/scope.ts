/**
 * What the AI can read, offered by the writing view: the open chapter, the
 * selection, what's on screen. The AI pane asks for it when sending. Beside
 * the page it asks this window; in a window of its own it asks the others
 * (through the main process).
 */
import { useSyncExternalStore } from 'react'
import { api, useIpcEvent } from '../api'

export interface Scope {
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  selection: string | null
  screen: string
}

interface Provider {
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  selection: string | null
  screen: () => string
}

const providers = new Map<string, Provider>()
const listeners = new Set<() => void>()
let version = 0

/** The writing view offers what it shows (call again whenever it changes). */
export function offerScope(seriesId: string, provider: Provider | null): void {
  if (provider) providers.set(seriesId, provider)
  else providers.delete(seriesId)
  version++
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** What this window's writing view shows for a story (re-renders on changes); null if none here. */
export function useLocalScope(seriesId: string): Omit<Provider, 'screen'> | null {
  useSyncExternalStore(subscribe, () => version)
  const p = providers.get(seriesId)
  return p
    ? {
        volumeId: p.volumeId,
        chapterId: p.chapterId,
        chapterTitle: p.chapterTitle,
        selection: p.selection,
      }
    : null
}

const resolve = (p: Provider): Scope => ({
  volumeId: p.volumeId,
  chapterId: p.chapterId,
  chapterTitle: p.chapterTitle,
  selection: p.selection,
  screen: p.chapterId ? p.screen() : '',
})

/** What to read now: from this window, or from another window showing the story. */
export async function fetchScope(seriesId: string): Promise<Scope | null> {
  const local = providers.get(seriesId)
  if (local) return resolve(local)
  return api.invoke('ai:scope', { seriesId }).catch(() => null)
}

/** Answers other windows asking what this one shows (mount once per window). */
export function useScopeAnswers(): void {
  useIpcEvent('ai:scopeRequest', ({ requestId, seriesId }) => {
    const p = providers.get(seriesId)
    if (p) void api.invoke('ai:scopeReply', { requestId, scope: resolve(p) }).catch(() => {})
  })
}
