import { useState, type FormEvent } from 'react'
import type { VolumeSummary } from '@shared/ipc'
import { api, describeError } from '../api'
import type { SaveState } from '../editor/useChapterSaver'

/**
 * Word counts, goal progress and save state. This is the only place that
 * reports saving or (later) sync status. No popups.
 */
export function StatusBar(props: {
  seriesId: string
  volume: VolumeSummary
  chapterWords: number | null
  sessionWords: number
  projectWords: number
  saveState: SaveState
  saveError: string | null
}) {
  const { goals } = props.volume
  const [editing, setEditing] = useState(false)

  return (
    <footer className="status-bar small">
      {props.chapterWords !== null && <span>Chapter {props.chapterWords.toLocaleString()}</span>}
      <Progress label="Session" value={props.sessionWords} goal={goals.sessionWords} signed />
      <Progress label="Project" value={props.projectWords} goal={goals.projectWords} />
      <span className="goal-anchor">
        <button className="link small" onClick={() => setEditing((v) => !v)}>
          {goals.sessionWords || goals.projectWords ? 'Goals' : 'Set goals'}
        </button>
        {editing && (
          <GoalsForm
            seriesId={props.seriesId}
            volume={props.volume}
            onDone={() => setEditing(false)}
          />
        )}
      </span>
      <span className="status-spacer" />
      <span className={props.saveState === 'error' ? 'error' : 'muted'} role="status">
        {props.saveState === 'error'
          ? `Not saved: ${props.saveError} (retrying)`
          : SAVE_LABELS[props.saveState]}
      </span>
    </footer>
  )
}

const SAVE_LABELS: Record<Exclude<SaveState, 'error'>, string> = {
  saved: 'Saved',
  unsaved: 'Editing…',
  saving: 'Saving…',
}

function Progress(props: { label: string; value: number; goal: number | null; signed?: boolean }) {
  const shown = `${props.signed && props.value > 0 ? '+' : ''}${props.value.toLocaleString()}`
  if (!props.goal) {
    return (
      <span>
        {props.label} {shown}
      </span>
    )
  }
  const ratio = Math.max(0, Math.min(1, props.value / props.goal))
  return (
    <span
      className={`progress ${ratio >= 1 ? 'done' : ''}`}
      title={`${Math.round(ratio * 100)}% of goal`}
    >
      {props.label} {shown} / {props.goal.toLocaleString()}
      <span className="progress-track" aria-hidden>
        <span className="progress-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
    </span>
  )
}

function GoalsForm(props: { seriesId: string; volume: VolumeSummary; onDone: () => void }) {
  const { goals } = props.volume
  const [session, setSession] = useState(goals.sessionWords?.toString() ?? '')
  const [project, setProject] = useState(goals.projectWords?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)

  const parse = (value: string) => {
    const n = Number.parseInt(value.replace(/[^\d]/g, ''), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.invoke('volume:update', {
        seriesId: props.seriesId,
        volumeId: props.volume.id,
        goals: { sessionWords: parse(session), projectWords: parse(project) },
      })
      props.onDone()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <form className="goals-form card stack" onSubmit={(e) => void submit(e)}>
      <label>
        Session goal (words)
        <input
          inputMode="numeric"
          value={session}
          placeholder="None"
          onChange={(e) => setSession(e.target.value)}
        />
      </label>
      <label>
        Project goal for {props.volume.name} (words)
        <input
          inputMode="numeric"
          value={project}
          placeholder="None"
          onChange={(e) => setProject(e.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" type="submit">
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
