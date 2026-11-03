/**
 * What the AI is told. The model only ever sees what the writer means it
 * to read (the reading scope), the world entries named in it, and for
 * "Ask the story" a compact digest of the world. It never sees the whole
 * book, and it is told not to rewrite the writer's prose.
 */
import type { ChatMessage } from './ollama'

export type AiMode = 'chat' | 'brainstorm' | 'ask'
export type ScopeKind = 'selection' | 'screen' | 'chapter'

const BASE = `You are a helpful assistant inside a novel-writing app. The writer writes their own prose: never rewrite or continue their text unless they clearly ask, and never claim to have changed their files. Be concise and concrete. Use plain text with short lists when helpful; no headings.`

const MODES: Record<AiMode, string> = {
  chat: 'Talk with the writer about their story and their writing.',
  brainstorm:
    'Brainstorm with the writer: offer several distinct, specific options (names, plot turns, what-ifs) as a short numbered list, each a line or two. Fit them to the story and world shown.',
  ask: 'Answer questions about the story using only the text and world notes provided. Quote or point to where the answer comes from. If the answer is not in them, say plainly that you can’t find it rather than guessing.',
}

const SCOPE_LABEL: Record<ScopeKind, string> = {
  selection: 'the passage the writer selected',
  screen: 'the part of the chapter on the writer’s screen',
  chapter: 'the whole chapter',
}

export interface PromptContext {
  mode: AiMode
  scope: { kind: ScopeKind; text: string; chapterTitle: string } | null
  /** Text forms of the world entries named in the scope. */
  entries: string[]
  /** For "Ask the story": a compact summary of the whole world. */
  digest?: string
}

/** The system message: role, rules, and what's being read. */
export function systemPrompt(context: PromptContext): string {
  const parts = [BASE, MODES[context.mode]]
  if (context.scope) {
    const { kind, text, chapterTitle } = context.scope
    parts.push(
      `The writer is working on the chapter “${chapterTitle || 'Untitled'}”. Below is ${SCOPE_LABEL[kind]}:\n\n<<<\n${text}\n>>>`,
    )
  }
  if (context.entries.length) {
    parts.push(`World notes for names in that text:\n\n${context.entries.join('\n\n---\n\n')}`)
  }
  if (context.digest) parts.push(`The whole world, briefly:\n\n${context.digest}`)
  return parts.join('\n\n')
}

export function chatMessages(
  context: PromptContext,
  history: { role: 'user' | 'assistant'; content: string }[],
): ChatMessage[] {
  return [{ role: 'system', content: systemPrompt(context) }, ...history]
}

/* ---------- grammar ---------- */

export function grammarMessages(paragraphs: string[], names: string[]): ChatMessage[] {
  const keep = names.length
    ? ` These names are correct as written, keep them exactly: ${names.slice(0, 200).join(', ')}.`
    : ''
  return [
    {
      role: 'system',
      content: `You fix spelling, grammar, punctuation and capitalisation in fiction. Change as little as possible. Never change word choice, style, tone, tense, dialect, slang, dialogue or meaning, and never add or remove sentences.${keep} Reply with JSON only: {"paragraphs": [...]} holding exactly ${paragraphs.length} strings, the corrected paragraphs in the same order (unchanged if already correct).`,
    },
    { role: 'user', content: JSON.stringify({ paragraphs }) },
  ]
}

/** The corrected paragraphs from a reply, or null when it isn't the shape asked for. */
export function parseGrammar(reply: string, expected: number): string[] | null {
  try {
    const start = reply.indexOf('{')
    const data = JSON.parse(
      start >= 0 ? reply.slice(start, reply.lastIndexOf('}') + 1) : reply,
    ) as {
      paragraphs?: unknown
    }
    const list = data.paragraphs
    if (!Array.isArray(list) || list.length !== expected) return null
    if (!list.every((p) => typeof p === 'string')) return null
    return list as string[]
  } catch {
    return null
  }
}

/* ---------- long chapters ---------- */

export function summaryMessages(text: string, part: number, parts: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Summarise this part of a novel chapter in at most 6 sentences: who is there, what happens, what changes. Keep names exactly. Plain text.',
    },
    { role: 'user', content: `Part ${part} of ${parts}:\n\n${text}` },
  ]
}
