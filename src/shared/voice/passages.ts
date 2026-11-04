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

/**
 * Text as a voice model reads it best: plain quotes (or none), dashes and
 * ellipses as pauses it knows, no stray symbols. Fancy punctuation is what
 * most often makes it stumble.
 */
export function forSpeech(text: string): string {
  return text
    .replace(/[“”„‟"]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/…|\.{3,}/g, '...')
    .replace(/[*_~#<>[\]{}|\\]/g, '')
    .replace(/\s*,\s*([.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits text into pieces of at most `max` characters, at sentence ends where it can. */
export function bySentence(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (cur && cur.length + sentence.length + 1 > max) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${sentence}` : sentence
  }
  if (cur) out.push(cur)
  return out
}

export function planPassages(
  blocks: Block[],
  speakers: { narrator: string | null; lines: Record<string, string> },
  cast: Cast,
  sizes = { first: 200, max: 350 },
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
    // A long paragraph is read in sentence-sized pieces (long passages make it stumble).
    for (const piece of bySentence(seg.text, sizes.max)) {
      const last = out[out.length - 1]
      const limit = out.length === 1 ? sizes.first : sizes.max
      if (last && !pause && last.voice === voice && last.text.length + piece.length < limit) {
        last.text += ` ${piece}`
        if (last.blocks[last.blocks.length - 1] !== seg.block) last.blocks.push(seg.block)
        continue
      }
      out.push({
        blocks: [seg.block],
        voice,
        text: piece,
        pauseBefore: out.length ? pause || (last && last.voice !== voice ? PAUSE.voices : 0) : 0,
      })
      pause = 0
    }
  }
  return out
}

/**
 * Whether enough speech is made to play straight to the end without
 * running out, judged from how fast it's being made so far; if not, about
 * how many seconds until it will be. Speech keeps being made while it waits
 * (and while it plays), so the wait is shorter than making it all.
 */
export function readyToPlay(input: {
  /** What's been made so far: its characters, seconds of audio, and seconds it took. */
  madeChars: number
  madeAudio: number
  madeTook: number
  /** Seconds of audio made and not yet played. */
  buffered: number
  /** Characters still to make. */
  remainingChars: number
  /** Allowance for it slowing down (1.15 = 15%). */
  margin?: number
}): { ready: boolean; waitSecs: number | null } {
  if (input.remainingChars <= 0) return { ready: true, waitSecs: 0 }
  if (input.madeAudio <= 0) return { ready: false, waitSecs: null }
  const m = input.margin ?? 1.15
  const perChar = input.madeAudio / Math.max(1, input.madeChars) // audio seconds per character
  const r = input.madeTook / input.madeAudio // seconds to make one second of audio
  const remainingAudio = input.remainingChars * perChar
  if (remainingAudio * r * m <= input.buffered) return { ready: true, waitSecs: 0 }
  const wait = (remainingAudio * r * m - input.buffered) / (m + 1 / r)
  return { ready: false, waitSecs: Math.max(0, Math.ceil(wait)) }
}
