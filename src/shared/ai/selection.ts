/**
 * AI on selected text (right-click → AI on the page): small, focused jobs
 * whose answers are only ever offered. The writer picks one or none; nothing
 * changes the page by itself.
 */
import { slopGuidance } from './personas'

export const SELECTION_ACTIONS = ['fix', 'rephrase', 'tighten', 'loosen', 'word', 'voice'] as const
export type SelectionAction = (typeof SELECTION_ACTIONS)[number]

/** What the right-click menu says for each. */
export const SELECTION_LABELS: Record<SelectionAction, string> = {
  fix: 'Fix spelling and grammar',
  rephrase: 'Other ways to say it',
  tighten: 'Tighten',
  loosen: 'Loosen',
  word: 'Better word',
  voice: 'In a character’s voice…',
}

/** The longest selection sent (longer ones are refused with a message, never cut). */
export const MAX_SELECTION_CHARS = 6000
/** "Better word" is for a word or a short phrase. */
export const MAX_WORD_SELECTION_WORDS = 4

export interface SelectionRequest {
  action: SelectionAction
  text: string
  /** The text just before and after the selection (the rest of its paragraph or two). */
  before: string
  after: string
  /** For `voice`: the character speaking, with their card. */
  character?: { name: string; card: string }
}

const KEEP_VOICE =
  'Keep the writer’s voice, tense, point of view, names, slang and the way their characters talk. Keep the meaning. Never add events, facts or lines of dialogue that are not there.'

const REPLY_FORMAT = (n: string) =>
  `Reply with JSON only: {"note": "one short line, or empty", "options": [${n}]}. Each option is the full replacement for the selected text, with nothing around it (no quotes added, no labels, no explanation).`

/** The system and user messages for a selection request. */
export function selectionPrompt(req: SelectionRequest): { system: string; user: string } {
  const context = `Text before it:\n${req.before || '(start)'}\n\nSELECTED TEXT:\n${req.text}\n\nText after it:\n${req.after || '(end)'}`
  const slop = slopGuidance()
  switch (req.action) {
    case 'fix':
      return {
        system: `You fix spelling, grammar and punctuation in a passage from a writer's own novel. Change only what is clearly a mistake. Leave style choices alone: fragments, slang, dialect, swearing, run-ons in dialogue and the writer's punctuation habits. If nothing needs fixing, return the text unchanged and say so in the note. ${REPLY_FORMAT('"the fixed text"')}`,
        user: context,
      }
    case 'rephrase':
      return {
        system: `Offer three other ways to write the selected text from a writer's own novel, each one clearly different (rhythm, word choice, sentence order), none of them better-sounding for its own sake. ${KEEP_VOICE} About the same length as the original.\n\n${slop}\n\n${REPLY_FORMAT('"option 1", "option 2", "option 3"')}`,
        user: context,
      }
    case 'tighten':
      return {
        system: `Tighten the selected text from a writer's own novel: cut filler, repetition and anything the reader already knows, so it reads faster. Offer two versions, one light trim and one harder cut. ${KEEP_VOICE}\n\n${slop}\n\n${REPLY_FORMAT('"light trim", "harder cut"')}`,
        user: context,
      }
    case 'loosen':
      return {
        system: `Loosen the selected text from a writer's own novel: give it a little more room to breathe (a beat, a clearer step, a small concrete detail already implied), so it reads less rushed. Offer two versions, one barely longer and one a bit fuller. ${KEEP_VOICE}\n\n${slop}\n\n${REPLY_FORMAT('"barely longer", "a bit fuller"')}`,
        user: context,
      }
    case 'word':
      return {
        system: `Suggest up to eight words or short phrases that could replace the selected word or phrase in this sentence from a writer's own novel, best fit first. Each must fit the sentence as it stands (same part of speech, tense and number) and the tone around it. In the note, say in a few words how the top choices differ, or leave it empty. ${REPLY_FORMAT('"word", "word", …')}`,
        user: context,
      }
    case 'voice': {
      const who = req.character?.name ?? 'the character'
      return {
        system: `You check whether a line or passage sounds like ${who}, a character in the writer's own novel, judged against their card below. In the note, say in one or two plain sentences what fits and what doesn't (word choice, rhythm, attitude); if it already sounds like them, say so. Then offer two rewrites that sound more like ${who}, changing as little as needed. ${KEEP_VOICE}\n\n${who}'s card:\n${req.character?.card ?? ''}\n\n${slop}\n\n${REPLY_FORMAT('"rewrite 1", "rewrite 2"')}`,
        user: context,
      }
    }
  }
}

export interface SelectionAnswer {
  note: string
  options: string[]
}

/**
 * Reads the model's reply leniently: JSON when it gave JSON (even with text
 * around it), else numbered or bulleted lines, else the whole reply as one
 * option. Empty options and exact repeats are dropped.
 */
export function parseSelectionAnswer(
  reply: string,
  req: Pick<SelectionRequest, 'action' | 'text'>,
): SelectionAnswer {
  let note = ''
  let options: string[] = []
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  let parsed = false
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(reply.slice(start, end + 1)) as { note?: unknown; options?: unknown }
      if (typeof data.note === 'string') note = data.note.trim()
      if (Array.isArray(data.options)) {
        options = data.options.filter((o): o is string => typeof o === 'string')
        parsed = true
      }
    } catch {
      // Not JSON after all: read it as lines below.
    }
  }
  if (!parsed) {
    const lines = reply
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const listed = lines.filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    options = listed.length
      ? listed.map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, ''))
      : [reply.trim()]
  }
  const seen = new Set<string>()
  options = options
    .map((o) => unwrap(o.trim(), req.text))
    .filter((o) => {
      if (!o || seen.has(o)) return false
      seen.add(o)
      return true
    })
  // "Fix" that changed nothing is a note, not an option.
  if (req.action === 'fix' && options.every((o) => o === req.text.trim())) {
    return { note: note || 'Nothing to fix.', options: [] }
  }
  return { note, options: options.slice(0, req.action === 'word' ? 8 : 3) }
}

/** Drops quote marks the model put around an option when the selection had none. */
function unwrap(option: string, original: string): string {
  const quoted = /^(["“'‘])([\s\S]*)(["”'’])$/.exec(option)
  if (!quoted) return option
  const o = original.trim()
  const originalQuoted = /^["“'‘]/.test(o) && /["”'’]$/.test(o)
  return originalQuoted ? option : quoted[2]!.trim()
}
