/**
 * Adaptive characters: picking lasting creative views out of the writer's
 * own messages, as short notes ("Prefers…", "Thinks…").
 */
import type { ChatMessage } from './ollama'

/** Most notes a character keeps (the oldest go first). */
export const MAX_LEARNED = 100

export function learnMessages(message: string, known: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You keep notes on a fiction writer's lasting creative views, so an AI portrayal of them stays accurate. From the message below, note only things that will still be true next month: their taste in stories, opinions about writing and craft, how they like to work or to receive feedback. Not facts about their story or characters (those are kept elsewhere), not one-off requests, not moods, not anything already known. Each note one short line in the third person ("Prefers…", "Thinks…", "Dislikes…"). If there's nothing like that, reply exactly NONE.

Already known:
${known.length ? known.map((k) => `- ${k}`).join('\n') : '(nothing yet)'}`,
    },
    { role: 'user', content: message.slice(0, 6000) },
  ]
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The new notes in a reply: one per line, without bullets, not already known. At most 3. */
export function parseLearned(reply: string, known: string[]): string[] {
  if (/^\s*none\s*\.?\s*$/i.test(reply)) return []
  const seen = new Set(known.map(norm))
  const out: string[] = []
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
    if (!line || /^none\b/i.test(line) || line.length < 8 || line.length > 300) continue
    const key = norm(line)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= 3) break
  }
  return out
}
