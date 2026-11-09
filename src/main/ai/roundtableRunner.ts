/** Autonomous, checkpointed Roundtable runner. Lives in the main process, not in a pane. */
import {
  advancePhase,
  nextParticipant,
  phaseIsReady,
  shouldSkipToFinal,
  type RoundtableSession,
  type RoundtablePost,
} from '@shared/ai/roundtable'
import type { LibraryHost } from '../libraryHost'
import type { AiService } from './service'

export type RoundtableRunState = 'running' | 'pausing' | 'paused' | 'failed' | 'complete'
export interface RoundtableRunStatus {
  seriesId: string
  conversationId: string
  state: RoundtableRunState
  speakerId: string | null
  targetId: string | null
  error: string | null
}
type Control = { paused: boolean; requestId: string | null }

export class RoundtableRunner {
  private readonly active = new Map<string, Control>()
  private readonly statuses = new Map<string, RoundtableRunStatus>()

  constructor(
    private readonly host: LibraryHost,
    private readonly ai: AiService,
    private readonly notify: (status: RoundtableRunStatus) => void,
  ) {}

  private key(seriesId: string, conversationId: string) {
    return `${seriesId}:${conversationId}`
  }

  status(seriesId: string, conversationId: string): RoundtableRunStatus {
    return (
      this.statuses.get(this.key(seriesId, conversationId)) ?? {
        seriesId,
        conversationId,
        state: 'paused',
        speakerId: null,
        targetId: null,
        error: null,
      }
    )
  }

  private publish(status: RoundtableRunStatus) {
    this.statuses.set(this.key(status.seriesId, status.conversationId), status)
    this.notify(status)
  }

  start(seriesId: string, conversationId: string): RoundtableRunStatus {
    const key = this.key(seriesId, conversationId)
    if (this.active.has(key)) return this.status(seriesId, conversationId)
    const control: Control = { paused: false, requestId: null }
    this.active.set(key, control)
    this.publish({
      seriesId,
      conversationId,
      state: 'running',
      speakerId: null,
      targetId: null,
      error: null,
    })
    void this.run(seriesId, conversationId, control).finally(() => {
      if (this.active.get(key) === control) this.active.delete(key)
    })
    return this.status(seriesId, conversationId)
  }

  pause(seriesId: string, conversationId: string): RoundtableRunStatus {
    const control = this.active.get(this.key(seriesId, conversationId))
    if (control) {
      control.paused = true
      if (control.requestId) this.ai.cancel(control.requestId)
    }
    const last = this.status(seriesId, conversationId)
    const status: RoundtableRunStatus = {
      ...last,
      state: control ? 'pausing' : 'paused',
      speakerId: null,
      targetId: null,
    }
    this.publish(status)
    return status
  }

  private async run(seriesId: string, conversationId: string, control: Control): Promise<void> {
    try {
      // A complete session with twelve members uses up to 96 participant turns, plus the briefing and summary.
      // Each completed turn is saved immediately, so an interrupted run can resume.
      while (!control.paused) {
        const file = await this.host.current.readConversation(seriesId, conversationId)
        const session = file.roundtable
        if (!session) throw new Error('This conversation is not a Roundtable.')
        if (session.phase === 'complete' && !session.summary) {
          // The Figurehead's neutral summary, beside everyone's own final proposals.
          const requestId = `figurehead-summary-${conversationId}-${Date.now()}`
          control.requestId = requestId
          this.publish({
            seriesId,
            conversationId,
            state: 'running',
            speakerId: 'figurehead',
            targetId: null,
            error: null,
          })
          const started = Date.now()
          const text = await this.ai.summarizeRoundtable(session, requestId)
          control.requestId = null
          if (control.paused) break
          await this.save(seriesId, file, {
            ...session,
            spentMs: (session.spentMs ?? 0) + (Date.now() - started),
            summary: { text, at: new Date().toISOString() },
          })
          continue
        }
        if (session.phase === 'complete') {
          this.publish({
            seriesId,
            conversationId,
            state: 'complete',
            speakerId: null,
            targetId: null,
            error: null,
          })
          return
        }
        // Prepare the shared evidence once. This checkpoint survives leaving the AI tab.
        if (!session.briefing) {
          const requestId = `figurehead-${conversationId}-${Date.now()}`
          control.requestId = requestId
          this.publish({
            seriesId,
            conversationId,
            state: 'running',
            speakerId: 'figurehead',
            targetId: null,
            error: null,
          })
          const started = Date.now()
          const briefing = await this.ai.prepareRoundtable(seriesId, session, requestId)
          control.requestId = null
          if (control.paused) break
          await this.save(seriesId, file, {
            ...session,
            briefing,
            spentMs: (session.spentMs ?? 0) + (Date.now() - started),
          })
          continue
        }

        // Running out of time: skip the rest of the debate so there's still an ending.
        if (shouldSkipToFinal(session)) {
          await this.save(seriesId, file, { ...session, phase: 'final' })
          continue
        }

        const speaker = nextParticipant(session)
        // Following each open discussion, participants reply directly to another participant
        // before moving to the next stage. Those replies appear in the individual threads.
        const discussion = session.phase === 'discussion1' || session.phase === 'discussion2'
        const directSpeaker =
          !speaker && discussion
            ? session.participants.find(
                (p) =>
                  !session.posts.some(
                    (post) =>
                      post.phase === session.phase &&
                      post.channel === 'direct' &&
                      post.targetId !== 'writer' &&
                      post.speakerId === p.id,
                  ),
              )
            : null
        if (!speaker && !directSpeaker) {
          if (!phaseIsReady(session)) throw new Error('The current phase cannot advance.')
          const advanced = advancePhase(session)
          if (control.paused) break
          await this.save(seriesId, file, advanced)
          continue
        }
        const person = (speaker ?? directSpeaker)!
        const direct = !speaker
        const index = session.participants.findIndex((p) => p.id === person.id)
        const targetId = direct
          ? session.participants[(index + 1) % session.participants.length]!.id
          : null
        const requestId = `rt-${conversationId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        control.requestId = requestId
        this.publish({
          seriesId,
          conversationId,
          state: 'running',
          speakerId: person.id,
          targetId,
          error: null,
        })
        const started = Date.now()
        const outcome = await this.ai.roundtableTurn({
          requestId,
          session,
          speakerId: person.id,
          targetId,
          direct,
        })
        control.requestId = null
        // A paused request never adds a response after pause was requested.
        if (control.paused) break
        const channel: RoundtablePost['channel'] = direct
          ? 'direct'
          : session.phase === 'revision' || session.phase === 'final'
            ? 'private'
            : session.phase === 'vote'
              ? 'ballot'
              : 'open'
        const post: RoundtablePost = {
          id: `rtpost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          at: new Date().toISOString(),
          phase: session.phase,
          speakerId: person.id,
          targetId,
          channel,
          text: outcome.text,
          ...(outcome.ranking ? { ranking: outcome.ranking } : {}),
          ...(outcome.summary ? { summary: outcome.summary } : {}),
        }
        await this.save(seriesId, file, {
          ...session,
          posts: [...session.posts, post],
          spentMs: (session.spentMs ?? 0) + (Date.now() - started),
        })
      }
      this.publish({
        seriesId,
        conversationId,
        state: 'paused',
        speakerId: null,
        targetId: null,
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish({
        seriesId,
        conversationId,
        state: control.paused ? 'paused' : 'failed',
        speakerId: null,
        targetId: null,
        error: control.paused ? null : message,
      })
    } finally {
      control.requestId = null
    }
  }

  private async save(
    seriesId: string,
    base: Awaited<ReturnType<LibraryHost['current']['readConversation']>>,
    session: RoundtableSession,
  ): Promise<void> {
    await this.host.current.saveConversation(seriesId, {
      ...base,
      roundtable: session,
      updatedAt: new Date().toISOString(),
    })
    // The normal library:changed event refreshes any open Roundtable views.
  }
}
