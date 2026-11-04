/**
 * Reading aloud with VoiceStudio: the chapter as passages, each one voice.
 * Lines in the same voice run together (up to a size), so it reads like a
 * reader and not line by line; the first passage is short so it starts fast.
 * The app sets the pauses: none inside a voice, a breath between voices, a
 * longer one at scene breaks.
 */
import { segments, type Block } from './script'

export interface Cast {
  narrator: string
  other: string
  characters: Record<string, string>
}

export interface Passage {
  /** The blocks (paragraphs) it covers, in order. */
  blocks: number[]
  /** The VoiceStudio voice ('' = its default). */
  voice: string
  text: string
  /** Silence before it, in milliseconds. */
  pauseBefore: number
}

export const PAUSE = { voices: 150, scene: 900 }

export function planPassages(
  blocks: Block[],
  speakers: { narrator: string | null; lines: Record<string, string> },
  cast: Cast,
  sizes = { first: 220, max: 700 },
): Passage[] {
  const voiceOf = (who: string | null, narration: boolean) => {
    if (who && cast.characters[who]) return cast.characters[who]!
    if (narration || (who && who === speakers.narrator)) return cast.narrator
    return cast.other || cast.narrator
  }
  const out: Passage[] = []
  let pause = 0
  for (const seg of segments(blocks)) {
    if (seg.kind === 'break') {
      pause = PAUSE.scene
      continue
    }
    const voice =
      seg.kind === 'quote'
        ? voiceOf((seg.key && speakers.lines[seg.key]) || null, false)
        : voiceOf(speakers.narrator, true)
    const last = out[out.length - 1]
    const limit = out.length === 1 ? sizes.first : sizes.max
    if (last && !pause && last.voice === voice && last.text.length + seg.text.length < limit) {
      last.text += ` ${seg.text}`
      if (last.blocks[last.blocks.length - 1] !== seg.block) last.blocks.push(seg.block)
      continue
    }
    out.push({
      blocks: [seg.block],
      voice,
      text: seg.text,
      pauseBefore: out.length ? pause || (last && last.voice !== voice ? PAUSE.voices : 0) : 0,
    })
    pause = 0
  }
  return out
}
