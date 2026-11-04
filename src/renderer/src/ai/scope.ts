/**
 * What the AI can read, offered by the writing view: the open chapter, the
 * selection, what's on screen. The AI pane asks for it when sending. Beside
 * the page it asks this window; in a window of its own it asks the others
 * (through the main process).
 */
import { useSyncExternalStore } from 'react'
import type { JSONContent } from '@tiptap/react'
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
  /** The chapter on the page (null when it can't be edited here), and a way to replace it. */
  doc: () => JSONContent | null
  replace: (doc: JSONContent) => boolean
}

/** The writing view that shows a story in this window, to edit its chapter (null if none). */
export function localEditor(seriesId: string): Provider | null {
  return providers.get(seriesId) ?? null
}

/** Asked from elsewhere (the ⋯ menu): open the AI with "Edit chapter" ticked and this request. */
let pendingEdit: { id: number; seriesId: string; draft: string } | null = null
export function requestEdit(seriesId: string, draft: string): void {
  pendingEdit = { id: (pendingEdit?.id ?? 0) + 1, seriesId, draft }
  version++
  for (const l of listeners) l()
}
/** The latest such request for a story (each has its own id, to act on once). */
export function editRequest(seriesId: string): { id: number; draft: string } | null {
  return pendingEdit?.seriesId === seriesId
    ? { id: pendingEdit.id, draft: pendingEdit.draft }
    : null
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
export function useLocalScope(
  seriesId: string,
): Pick<Provider, 'volumeId' | 'chapterId' | 'chapterTitle' | 'selection'> | null {
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
