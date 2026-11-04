/** "Update the world from this chapter", from anywhere: the AI reads it; findings go to the inbox. */
import type { AiJobInfo, IpcResult } from '@shared/ipc'
import { api } from '../api'

type Done = NonNullable<AiJobInfo['result']>

const n = (count: number | undefined, one: string, many: string) =>
  count ? `${count} ${count === 1 ? one : many}` : ''

/** What reading a chapter did, in words. */
export function worldUpdateNote(title: string, r: Done): string {
  const parts = [
    n(r.applied, 'change made', 'changes made'),
    n(r.suggestions, 'suggestion', 'suggestions'),
    n(r.continuity, 'thing that may not fit', 'things that may not fit'),
    n(r.questions, 'question for you', 'questions for you'),
  ].filter(Boolean)
  const name = `“${title || 'Untitled'}”`
  if (!parts.length) return `Read ${name}: nothing new for the world.`
  const where = r.applied
    ? 'Each is listed in the world’s inbox, where you can undo it.'
    : 'They’re waiting in the world’s inbox.'
  return `Read ${name}: ${parts.join(', ')}. ${where}`
}

/** What sorting names did, in words. */
export function sortNamesNote(r: Done): string {
  const parts = [
    n(r.applied, 'entry made', 'entries made'),
    n(r.suggestions, 'suggestion', 'suggestions'),
    n(r.skipped, 'set aside as not a name', 'set aside as not names'),
  ].filter(Boolean)
  return parts.length
    ? `Sorted the new names: ${parts.join(', ')}. Each is in the inbox, where you can undo it.`
    : 'The AI couldn’t sort those names. Try again.'
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
