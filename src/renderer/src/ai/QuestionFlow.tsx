import { useState } from 'react'
import type { QuestionSet } from '@shared/ai/questions'

export interface QuestionProgress {
  /** One per question reached: the answer, or null when skipped. */
  answers: (string | null)[]
  /** Finished (or stopped) and sent back to the AI. */
  done: boolean
}

/**
 * The AI's planned questions, one at a time: ready answers when it gave
 * some (one maybe recommended, with why), always a box for your own, Skip,
 * and “That's enough” to stop and get the summary.
 */
export function QuestionFlow(props: {
  set: QuestionSet
  progress: QuestionProgress
  disabled: boolean
  onAnswer: (answer: string | null) => void
  onStop: () => void
}) {
  const { set, progress } = props
  const [own, setOwn] = useState('')
  const total = set.questions.length
  const at = progress.answers.length
  const answered = progress.answers.filter((a) => a !== null).length

  if (progress.done || at >= total) {
    return (
      <div className="qa qa-done small muted">
        {answered} of {total} answered{at < total ? ', then stopped' : ''}.
      </div>
    )
  }
  const q = set.questions[at]!
  const give = (answer: string | null) => {
    setOwn('')
    props.onAnswer(answer)
  }
  return (
    <div className="qa">
      {at === 0 && set.intro && <p className="qa-intro small">{set.intro}</p>}
      <div className="qa-count small muted">
        <span>
          Question {at + 1} of {total}
        </span>
        <span className="status-spacer" />
        <button type="button" className="link" disabled={props.disabled} onClick={() => give(null)}>
          Skip
        </button>
        <button
          type="button"
          className="link"
          disabled={props.disabled}
          title="Stop here and get the summary"
          onClick={props.onStop}
        >
          That’s enough
        </button>
      </div>
      <p className="qa-q">{q.q}</p>
      {q.options && (
        <div className="qa-options">
          {q.options.map((o, i) => (
            <button
              key={i}
              type="button"
              className={i === q.recommended ? 'qa-option recommended' : 'qa-option'}
              disabled={props.disabled}
              onClick={() => give(o)}
            >
              {o}
              {i === q.recommended && <span className="qa-rec"> (recommended)</span>}
            </button>
          ))}
        </div>
      )}
      {q.recommended !== undefined && q.why && <p className="qa-why small muted">{q.why}</p>}
      <form
        className="qa-own"
        onSubmit={(e) => {
          e.preventDefault()
          if (own.trim()) give(own.trim())
        }}
      >
        <textarea
          aria-label="Your answer"
          placeholder={q.options ? 'Or type your own answer…' : 'Your answer…'}
          value={own}
          rows={2}
          disabled={props.disabled}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (own.trim()) give(own.trim())
            }
          }}
        />
        <div className="row">
          <span className="status-spacer" />
          <button type="submit" className="primary" disabled={props.disabled || !own.trim()}>
            Answer
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * In the conversation: a short line while the questions are open (they're
 * answered in the box below), then a record of the answers that opens.
 */
export function QuestionRecord(props: { set: QuestionSet; progress?: QuestionProgress }) {
  const total = props.set.questions.length
  const answers = props.progress?.answers ?? []
  const finished = !!props.progress?.done || answers.length >= total
  if (!finished) {
    return (
      <p className="qa-line small muted">
        {total === 1 ? 'A question' : `${total} questions`}: answer below
        {answers.length ? ` (${answers.length} done)` : ''}.
      </p>
    )
  }
  const answered = answers.filter((a) => a !== null).length
  return (
    <details className="qa-record small">
      <summary className="muted">
        {answered} of {total} questions answered{answers.length < total ? ', then stopped' : ''}
      </summary>
      <ol>
        {props.set.questions.map((q, i) =>
          i < answers.length ? (
            <li key={i}>
              <span className="muted">{q.q}</span>
              <br />
              {answers[i] ?? <em className="muted">skipped</em>}
            </li>
          ) : null,
        )}
      </ol>
    </details>
  )
}
