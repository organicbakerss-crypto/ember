/**
 * What the AI is told. The model only ever sees what the writer means it
 * to read (the reading scope), the world entries named in it, and for
 * "Ask the story" a compact digest of the world. It never sees the whole
 * book, and it is told not to rewrite the writer's prose.
 */
import type { ChatMessage } from './ollama'

export type AiMode = 'chat' | 'brainstorm' | 'ask'
export type ScopeKind = 'selection' | 'screen' | 'chapter' | 'story'

const BASE = `You are a helpful assistant inside a novel-writing app. The writer writes their own prose: never rewrite or continue their text unless they clearly ask, and never claim to have changed their files. To show what you mean, give at most one example line. Be concise and concrete. Use plain text with short lists when helpful; no headings.
How you give feedback:
- Give opinions on the writing only when asked.
- Every problem you point out comes with a specific fix: what to add, cut, move or clarify, and where.
- If the writer pushes back on a point, offer one new angle with a new fix. If they push back on it again, drop it gracefully and don't raise it again in this conversation.
- A continuity slip (an eye colour that changed, someone in two places) gets one mention with its fix; if the writer says it's intentional, let it go.`

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
  story: 'the whole story',
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
      kind === 'story'
        ? `Below is the whole story “${chapterTitle || 'Untitled'}” so far, as a short summary of each chapter in order (summaries, not the writer's own words). When you answer from it, say which chapter:\n\n<<<\n${text}\n>>>`
        : `The writer is working on the chapter “${chapterTitle || 'Untitled'}”. Below is ${SCOPE_LABEL[kind]}:\n\n<<<\n${text}\n>>>`,
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

/* ---------- editing the chapter ---------- */

export function editMessages(input: {
  instruction: string
  chapterTitle: string
  chapter: string
  /** The conversation so far (it may hold a scene the writer wants placed). */
  history: { role: 'user' | 'assistant'; content: string }[]
  names: string[]
}): ChatMessage[] {
  const keep = input.names.length
    ? ` These names are spelled correctly as they are: ${input.names.slice(0, 200).join(', ')}.`
    : ''
  const earlier = input.history.length
    ? `The conversation so far (it may contain text the writer wants used):\n\n${input.history
        .map((m) => `${m.role === 'user' ? 'Writer' : 'You'}: ${m.content}`)
        .join('\n\n')}\n\n`
    : ''
  return [
    {
      role: 'system',
      content: `You edit one chapter of the writer's novel, doing exactly what they ask and nothing else. Every paragraph you weren't asked to change stays word for word as it is.${keep} The chapter is in Markdown: paragraphs separated by blank lines, "* * *" for scene breaks, ## for headings, **bold**, *italic*, ~~strike~~, <u>underline</u>, > for quoted text. Reply with the whole edited chapter in that same Markdown, from its first paragraph to its last, and nothing else: no introduction, no notes, no code fence.`,
    },
    {
      role: 'user',
      content: `${earlier}What to do: ${input.instruction}\n\nThe chapter “${input.chapterTitle || 'Untitled'}”:\n\n${input.chapter}`,
    },
  ]
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
