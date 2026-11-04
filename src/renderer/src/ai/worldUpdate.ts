/** "Update the world from this chapter", from anywhere: the AI reads it; findings go to the inbox. */
import type { IpcResult } from '@shared/ipc'
import { api } from '../api'

/** What reading a chapter found, in words. */
export function worldUpdateNote(title: string, r: IpcResult<'ai:updateWorld'>): string {
  const parts = [
    r.suggestions && `${r.suggestions} ${r.suggestions === 1 ? 'suggestion' : 'suggestions'}`,
    r.continuity &&
      `${r.continuity} ${r.continuity === 1 ? 'thing that may not fit' : 'things that may not fit'}`,
    r.questions && `${r.questions} ${r.questions === 1 ? 'question' : 'questions'} for you`,
  ].filter(Boolean)
  const name = `“${title || 'Untitled'}”`
  return parts.length
    ? `Read ${name}: ${parts.join(', ')}. They’re waiting in the world’s inbox; nothing changes until you accept it.`
    : `Read ${name}: nothing new for the world.`
}

export function updateWorld(ref: {
  seriesId: string
  volumeId: string
  chapterId: string
}): Promise<IpcResult<'ai:updateWorld'>> {
  return api.invoke('ai:updateWorld', {
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...ref,
  })
}
