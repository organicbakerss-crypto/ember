/**
 * What the AI is told. The model only ever sees what the writer means it
 * to read (the reading scope), the world entries named in it, and for
 * "Ask the story" a compact digest of the world. It never sees the whole
 * book, and it is told not to rewrite the writer's prose.
 */
import type { ChatMessage } from './ollama'
import { personaInstructions, personaReminder } from '@shared/ai/personas'
import { QUESTIONS_GUIDE } from '@shared/ai/questions'
import { storyCharacterReminder } from '@shared/ai/storyCharacters'

export type AiMode = 'chat' | 'brainstorm' | 'ask'
export type ScopeKind = 'selection' | 'screen' | 'chapter' | 'story' | 'full'

const BASE = `You're talking with a writer inside their novel-writing app. They write their own prose: never rewrite or continue their text unless they clearly ask, and never claim to have changed their files. To show what you mean, give at most one example line.
- Give opinions on the writing when asked for them.
- If the writer pushes back on a point, offer one new angle. If they push back again, drop it and don't raise it again in this conversation.
- A continuity slip (an eye colour that changed, someone in two places) gets one mention with its fix; if the writer says it's intentional, let it go.`

const MODES: Record<AiMode, string> = {
  chat: 'Talk with the writer about their story and their writing.',
  brainstorm:
    'Brainstorm with the writer: offer distinct, specific options (names, plot turns, what-ifs) that fit the story and world shown, presented in your own way.',
  ask: 'Answer questions about the story using only the text and world notes provided. Quote or point to where the answer comes from. If the answer is not in them, say plainly that you can’t find it rather than guessing.',
}

const SCOPE_LABEL: Record<ScopeKind, string> = {
  selection: 'the passage the writer selected',
  screen: 'the part of the chapter on the writer’s screen',
  chapter: 'the whole chapter',
  story: 'the whole story',
  full: 'the whole story, word for word',
}

export interface PromptContext {
  characterId?: string
  /** What this (adaptive) character has learned from the writer. */
  learned?: string[]
  /** One of the writer's own story characters (instead of a built-in character). */
  storyCharacter?: { name: string; instructions: string }
  mode: AiMode
  scope: { kind: ScopeKind; text: string; chapterTitle: string } | null
  /** Text forms of the world entries named in the scope. */
  entries: string[]
  /** For "Ask the story": a compact summary of the whole world. */
  digest?: string
  /** The whole story was read in parts: `scope.text` is the notes made on the way. */
  readInParts?: boolean
  /** What was looked up for the question (so the answer isn't blind). */
  lookup?: { summaries: string[]; passages: string[] }
  /** For brainstorming: the chapters just before the open one. */
  before?: { title: string; text: string }[]
  /** Files the writer attached to the conversation (kept on this computer). */
  attachments?: { name: string; text: string }[]
}

const GROUNDED = `What you know about the writer's story comes only from what is given below. When it doesn't cover something, say so and say where it might be (a chapter, an entry), rather than guessing; never invent events, names or facts of the story.`

/** The system message: role, rules, and what's being read. */
export function systemPrompt(context: PromptContext): string {
  const parts = [
    context.storyCharacter
      ? context.storyCharacter.instructions
      : personaInstructions(context.characterId, context.learned),
    BASE,
    MODES[context.mode],
    QUESTIONS_GUIDE,
    GROUNDED,
  ]
  if (context.attachments?.length) {
    parts.push(
      `Files the writer attached to this conversation (notes, hand-offs; not the story itself):\n\n${context.attachments
        .map((a) => `### ${a.name}\n<<<\n${a.text}\n>>>`)
        .join('\n\n')}`,
    )
  }
  if (context.before?.length) {
    parts.push(
      `The chapters just before the one being worked on, for context:\n\n${context.before
        .map((c) => `### ${c.title}\n<<<\n${c.text}\n>>>`)
        .join('\n\n')}`,
    )
  }
  if (context.scope) {
    const { kind, text, chapterTitle } = context.scope
    parts.push(
      kind === 'story'
        ? `Below is the whole story “${chapterTitle || 'Untitled'}” so far, as a short summary of each chapter in order (summaries, not the writer's own words). When you answer from it, say which chapter:\n\n<<<\n${text}\n>>>`
        : kind === 'full' && context.readInParts
          ? `You read the whole story “${chapterTitle || 'Untitled'}” in parts, keeping notes for the writer's question. Your notes:\n\n<<<\n${text}\n>>>`
          : kind === 'full'
            ? `Below is the whole story “${chapterTitle || 'Untitled'}” so far, word for word, chapter by chapter. When you answer from it, say which chapter:\n\n<<<\n${text}\n>>>`
            : `The writer is working on the chapter “${chapterTitle || 'Untitled'}”. Below is ${SCOPE_LABEL[kind]}:\n\n<<<\n${text}\n>>>`,
    )
  }
  if (context.lookup?.summaries.length) {
    parts.push(
      `Chapter summaries looked up for this question:\n\n${context.lookup.summaries.join('\n\n')}`,
    )
  }
  if (context.lookup?.passages.length) {
    parts.push(
      `Passages from the story looked up for this question (the writer's own words, with where they are):\n\n${context.lookup.passages.join('\n\n')}`,
    )
  }
  if (context.entries.length) {
    parts.push(`World notes for names in that text:\n\n${context.entries.join('\n\n---\n\n')}`)
  }
  if (context.digest) parts.push(`The whole world, briefly:\n\n${context.digest}`)
  parts.push(
    context.storyCharacter
      ? storyCharacterReminder(context.storyCharacter.name)
      : personaReminder(context.characterId),
  )
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
      content: `You edit one chapter of the writer's novel, doing exactly what they ask and nothing else. Every paragraph you weren't asked to change stays word for word as it is.${keep} The chapter is in Markdown: paragraphs separated by blank lines, "* * *" for scene breaks, ![…](picture:…) for pictures (keep each one exactly as it is unless asked to move it), ## for headings, **bold**, *italic*, ~~strike~~, <u>underline</u>, > for quoted text. Reply with the whole edited chapter in that same Markdown, from its first paragraph to its last, and nothing else: no introduction, no notes, no code fence.`,
    },
    {
      role: 'user',
      content: `${earlier}What to do: ${input.instruction}\n\nThe chapter “${input.chapterTitle || 'Untitled'}”:\n\n${input.chapter}`,
    },
  ]
}

/* ---------- long chapters ---------- */

/** One step of reading the whole story in parts: the notes so far, updated with the next part. */
export function notesMessages(
  question: string,
  notes: string,
  part: string,
  index: number,
  count: number,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are reading a novel in ${count} parts to answer the writer's question afterwards. Keep running notes: everything in the story that bears on the question (events, who, what changes, exact details, with the chapter each is in). Reply with the full updated notes only, at most 600 words; keep the notes so far unless the new part corrects them. Keep names exactly.`,
    },
    {
      role: 'user',
      content: `The writer's question: ${question || '(none: note the main events, characters and threads)'}\n\nYour notes so far:\n${notes || '(none yet)'}\n\nPart ${index} of ${count}:\n\n${part}`,
    },
  ]
}

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
