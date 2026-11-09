/**
 * AI notes on a chapter: a careful first reader's notes left as comments on
 * the exact words they're about (continuity, unclear bits, slips, accidental
 * repeats). Never taste, never rewrites; nothing in the text changes.
 */

export interface PageNote {
  /** Exact words from the chapter the note is about. */
  quote: string
  note: string
}

/** Words per part the chapter is read in (so smaller models keep up). */
export const NOTES_PART_WORDS = 1200
/** Notes kept per part, at most. */
export const NOTES_PER_PART = 6

/** The chapter's paragraphs grouped into parts of about `NOTES_PART_WORDS` words. */
export function notesParts(paragraphs: readonly string[], words = NOTES_PART_WORDS): string[] {
  const parts: string[] = []
  let current: string[] = []
  let count = 0
  for (const p of paragraphs) {
    if (!p.trim()) continue
    const n = p.split(/\s+/).filter(Boolean).length
    if (count && count + n > words) {
      parts.push(current.join('\n\n'))
      current = []
      count = 0
    }
    current.push(p)
    count += n
  }
  if (current.length) parts.push(current.join('\n\n'))
  return parts
}

export function pageNotesPrompt(input: {
  part: string
  partNumber: number
  parts: number
  chapterTitle: string
  /** What the world says about who and what is named (may be empty). */
  world: string
  /** Summaries of the chapters before this one, oldest first (may be empty). */
  earlier: string
}): { system: string; user: string } {
  return {
    system: `You are a careful first reader of a chapter from the writer's own novel. Leave short notes on real problems only:
- continuity: something that contradicts the world notes or the earlier chapters (an eye colour, who knows what, where someone is, someone dead or absent);
- unclear: the reader can't tell who is speaking, who "he" or "she" is, where they are, or what just happened;
- slips: the tense or point of view changes by mistake, a name spelled two ways, someone sits down twice, a time of day that jumps;
- repeats: the same word or phrase close together in a way that sounds accidental.
Nothing else: no taste or style advice, no praise, no rewrites, no summaries, no suggestions for the plot. Fragments, slang and the characters' way of talking are the writer's choice, not mistakes. Spelling and grammar are checked elsewhere; leave them out.
Each note has "quote": a few words up to one sentence copied exactly from the text (same spelling and punctuation) and long enough to appear only once in it (when the words repeat, quote the one you mean with a word or two around it), and "note": the problem in one plain sentence, saying what it clashes with when it's continuity. At most ${NOTES_PER_PART} notes; no notes is a good answer when nothing is wrong.
Reply with JSON only: {"notes": [{"quote": "...", "note": "..."}]}`,
    user: `${input.world ? `World notes:\n${input.world}\n\n` : ''}${input.earlier ? `Earlier chapters:\n${input.earlier}\n\n` : ''}“${input.chapterTitle || 'This chapter'}”, part ${input.partNumber} of ${input.parts}:\n\n${input.part}`,
  }
}

/** Reads the notes leniently; drops ones without a quote that's really in the part. */
export function parsePageNotes(reply: string, part: string): PageNote[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (data as { notes?: unknown }).notes
  if (!Array.isArray(raw)) return []
  const text = plain(part)
  const seen = new Set<string>()
  const out: PageNote[] = []
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue
    const quote = String((n as { quote?: unknown }).quote ?? '').trim()
    const note = String((n as { note?: unknown }).note ?? '').trim()
    if (!quote || !note || quote.length > 400) continue
    if (!text.toLowerCase().includes(plain(quote).toLowerCase())) continue
    if (seen.has(quote)) continue
    seen.add(quote)
    out.push({ quote, note: note.slice(0, 500) })
    if (out.length >= NOTES_PER_PART) break
  }
  return out
}

/** Curly quotes and odd spaces made plain, one character for one (positions stay the same). */
export function plain(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[–—]/g, '-')
}
