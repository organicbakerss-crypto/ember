/**
 * AI work runs here, in the background of the app, not in the window that
 * asked: closing the AI pane or going elsewhere doesn't stop or lose it.
 * Each job streams to every window (so a reopened pane carries on showing
 * it), keeps what it has so far, saves its conversation itself, and stays
 * listed when finished until a pane has taken its result.
 */
import type { AiJobInfo } from '@shared/ipc'

/** Finished jobs nobody collected are forgotten after this long. */
const KEEP_MS = 6 * 60 * 60 * 1000

export interface JobEvents {
  token(requestId: string, text: string): void
  progress(requestId: string, text: string): void
  /** A job started, finished, failed or was stopped. */
  changed(job: AiJobInfo): void
}

export class AiJobs {
  private readonly jobs = new Map<string, AiJobInfo>()

  constructor(private readonly events: JobEvents) {}

  /**
   * Runs a job. `run` gets callbacks for streamed text and progress; its
   * result (or failure) is kept on the job. Resolves like `run` does.
   */
  async run<T>(
    info: Omit<
      AiJobInfo,
      'state' | 'text' | 'progress' | 'error' | 'result' | 'startedAt' | 'endedAt'
    >,
    run: (onToken: (text: string) => void, onProgress: (text: string) => void) => Promise<T>,
    finish: (
      job: AiJobInfo,
      outcome: { value?: T; error?: unknown },
    ) => Promise<unknown> = async () => {},
  ): Promise<T> {
    this.prune()
    const job: AiJobInfo = {
      ...info,
      state: 'running',
      text: '',
      progress: '',
      error: null,
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    }
    this.jobs.set(job.id, job)
    this.events.changed(job)
    try {
      const value = await run(
        (text) => {
          job.text += text
          this.events.token(job.id, text)
        },
        (text) => {
          job.progress = text
          this.events.progress(job.id, text)
        },
      )
      job.state = 'done'
      if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
        job.text = value.text
      } else job.result = (value ?? null) as AiJobInfo['result']
      await finish(job, { value }).catch(() => {})
      return value
    } catch (err) {
      const code = (err as { code?: string }).code
      job.state = code === 'cancelled' ? 'cancelled' : 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      await finish(job, { error: err }).catch(() => {})
      throw err
    } finally {
      job.progress = ''
      job.endedAt = new Date().toISOString()
      this.events.changed(job)
    }
  }

  /** A story's jobs: running ones, and finished ones not yet taken. */
  list(seriesId: string): AiJobInfo[] {
    this.prune()
    return [...this.jobs.values()].filter((j) => j.seriesId === seriesId)
  }

  /** A pane took a finished job's result: forget it. */
  seen(id: string): void {
    const job = this.jobs.get(id)
    if (job && job.state !== 'running') this.jobs.delete(id)
  }

  private prune() {
    const cutoff = Date.now() - KEEP_MS
    for (const [id, job] of this.jobs) {
      if (job.endedAt && new Date(job.endedAt).getTime() < cutoff) this.jobs.delete(id)
    }
  }
}
