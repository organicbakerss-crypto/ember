/**
 * Who says what: the app finds every quoted line itself; the AI answers one
 * narrow question per chapter (who says line 1, 2, 3…, and who tells the
 * chapter if it's in the first person). Names are matched to the world's
 * entries where they can be. Used for reading aloud and the audiobook script.
 */
import type { EntrySummary } from '@shared/ipc'
import type { Speaker } from '@shared/schema'
import type { Segment } from '@shared/voice/script'
import type { ChatMessage } from './ollama'
import { norm } from './worldUpdate'

/** The chapter with each quote numbered, in parts of about `words` words. */
export function numberedParts(segs: Segment[], words: number): { text: string; count: number }[] {
  const parts: { text: string; count: number }[] = []
  let lines: string[] = []
  let block = -1
  let n = 0
  let size = 0
  let count = 0
  const push = () => {
    if (lines.length) parts.push({ text: lines.join(''), count })
    lines = []
    size = 0
    count = 0
  }
  for (const s of segs) {
    if (s.block !== block) {
      if (size > words) push()
      if (lines.length) lines.push('\n\n')
      block = s.block
    } else lines.push(' ')
    if (s.kind === 'break') lines.push('* * *')
    else if (s.kind === 'quote') {
      n++
      count++
      lines.push(`[${n}] ${s.text}`)
    } else lines.push(s.text)
    size += s.text.split(/\s+/).length
  }
  push()
  return parts
}

export function speakersMessages(input: {
  chapterTitle: string
  text: string
  cast: string[]
  pov: string | null
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You mark who says each numbered line of dialogue in a chapter of a novel, so it can be read aloud with the right voices. Reply with JSON only: {"narrator":"","speakers":{"1":""}}
- narrator: if the chapter is told in the first person ("I"), the name of the character telling it; otherwise "".
- speakers: for every numbered line [n], who says it: a character's exact name (from the list if they're in it), "narrator" if the first-person narrator says it, or "unknown" if you really can't tell.
Use the context: tags like "she said", who spoke just before (dialogue often goes back and forth), and who is in the scene. A line split by a tag ("Hey," I said. "Wait.") has the same speaker for both parts.`,
    },
    {
      role: 'user',
      content: [
        input.cast.length ? `Characters in this story: ${input.cast.join(', ')}.` : '',
        input.pov ? `The chapter's point-of-view character is ${input.pov}.` : '',
        `The chapter “${input.chapterTitle || 'Untitled'}”:\n\n${input.text}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ]
}

/** The AI's answer, read forgivingly: line number → name, and the narrator's name. */
export function parseSpeakers(reply: string): { narrator: string; speakers: Map<number, string> } {
  const out = { narrator: '', speakers: new Map<number, string>() }
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  try {
    const data = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    if (typeof data['narrator'] === 'string') out.narrator = data['narrator'].trim()
    const sp = data['speakers']
    if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
      for (const [k, v] of Object.entries(sp as Record<string, unknown>)) {
        const n = Number(k.replace(/\D/g, ''))
        if (Number.isInteger(n) && n > 0 && typeof v === 'string' && v.trim()) {
          out.speakers.set(n, v.trim())
        }
      }
    }
  } catch {
    // Unreadable: nobody marked.
  }
  return out
}

/** A name from the AI as a speaker: the world's entry when it matches one. */
export function resolveSpeaker(
  name: string,
  entries: EntrySummary[],
  narrator: Speaker | null,
): Speaker | null {
  const n = norm(name)
  if (!n || n === 'unknown') return null
  if (n === 'narrator' || n === 'i' || n === 'me') return narrator
  const hit = entries.find((e) => [e.name, ...e.aliases].some((x) => norm(x) === n))
  if (hit) return { entryId: hit.id, name: hit.name }
  return { entryId: null, name: name.trim().slice(0, 200) }
}
