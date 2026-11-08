/**
 * The AI asking the writer questions: a planned list, each question with
 * optional ready answers (only when they help), an optional recommendation
 * with its reason, and always room for the writer's own answer.
 *
 * The model writes the list as a fenced ```questions block of JSON; the app
 * shows it one question at a time. Anything it can't read stays plain text.
 */
import { z } from 'zod'

const questionSchema = z.object({
  q: z.string().trim().min(1).max(600),
  options: z.array(z.string().trim().min(1).max(200)).max(6).optional().catch(undefined),
  /** Index into `options`. */
  recommended: z.number().int().nonnegative().optional().catch(undefined),
  why: z.string().trim().max(400).optional().catch(undefined),
})
const blockSchema = z.object({
  intro: z.string().trim().max(1000).optional().catch(undefined),
  questions: z.array(questionSchema).min(1).max(300),
})

export type Question = z.infer<typeof questionSchema>
export interface QuestionSet {
  intro?: string
  questions: Question[]
}

const FENCE = /```questions\s*\n([\s\S]*?)\n?```/

/** The question set in an answer, with the text around it; null when there's none (or it can't be read). */
export function findQuestions(
  text: string,
): { before: string; set: QuestionSet; after: string } | null {
  const m = FENCE.exec(text)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[1]!)
  } catch {
    return null
  }
  const parsed = blockSchema.safeParse(raw)
  if (!parsed.success) return null
  const questions = parsed.data.questions.map((q) => {
    const options = q.options?.length ? q.options : undefined
    const rec =
      options && q.recommended !== undefined && q.recommended < options.length
        ? q.recommended
        : undefined
    return {
      q: q.q,
      ...(options ? { options } : {}),
      ...(rec !== undefined ? { recommended: rec, ...(q.why ? { why: q.why } : {}) } : {}),
    }
  })
  return {
    before: text.slice(0, m.index).trim(),
    set: { ...(parsed.data.intro ? { intro: parsed.data.intro } : {}), questions },
    after: text.slice(m.index + m[0].length).trim(),
  }
}

/** The writer's answers, as the message that goes back to the AI. */
export function answersMessage(
  set: QuestionSet,
  answers: (string | null)[],
  stoppedEarly: boolean,
): string {
  const lines = set.questions.map((q, i) => {
    const a = answers[i]
    return `${i + 1}. ${q.q}\n   → ${a === undefined ? '(not reached)' : a === null ? '(skipped)' : a}`
  })
  return [
    stoppedEarly
      ? 'I stopped the questions there. My answers so far:'
      : 'My answers to your questions:',
    '',
    ...lines,
    '',
    'Now sum up what we decided. Then tell me what’s strong and what’s weak in it, with a concrete fix for each weak point, and point out anything that contradicts the story so far.',
  ].join('\n')
}

/** What the model is told about asking. */
export const QUESTIONS_GUIDE = `Asking the writer questions:
- When the writer asks you to ask them questions, or you truly need to know something before you can help, plan the questions first and send them all at once in a fenced block, like this:
\`\`\`questions
{"intro": "A line on what these are for.", "questions": [
  {"q": "Who betrays the crew?", "options": ["Eli", "Sam", "Mark"], "recommended": 2, "why": "Mark's debt from chapter 4 hasn't paid off yet."},
  {"q": "What does Mara fear most, and why?"}
]}
\`\`\`
- Ask as many as the writer asked for, or as many as you really need. The app shows them one at a time; the writer can skip any or stop early.
- Give "options" only when a few clear choices would help; leave them out for open questions where ready answers would box the writer in.
- Add "recommended" (the option's index from 0) with a one-line "why" only when the story gives a real reason (it fits what's happened, pays off a setup, avoids a contradiction), never for matters of taste. Most questions have none.
- Don't ask questions you could answer from the story you were given.`
