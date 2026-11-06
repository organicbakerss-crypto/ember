import { describe, expect, it, vi } from 'vitest'
import { RoundtableRunner, type RoundtableRunStatus } from './roundtableRunner'
import type { LibraryHost } from '../libraryHost'
import type { AiService } from './service'
import type { ConversationFile } from '@shared/schema'
import type { RoundtableSession } from '@shared/ai/roundtable'

function fixture() {
  const now = '2026-11-06T12:00:00.000Z'
  const state: RoundtableSession = {
    topic: 'Choose the strongest story premise',
    participants: [
      { id: 'john-ai', name: 'John AI', kind: 'regular' },
      { id: 'bo', name: 'Bo', kind: 'regular' },
      { id: 'roman', name: 'Roman', kind: 'regular' },
    ],
    phase: 'proposals', posts: [],
  }
  let file: ConversationFile = {
    formatVersion: 1, id: 'cnv_0123456789abcdef', mode: 'chat',
    title: 'Roundtable', characterId: 'john-ai', createdAt: now, updatedAt: now,
    messages: [], roundtable: state,
  }
  const readConversation = vi.fn(async () => structuredClone(file))
  const saveConversation = vi.fn(async (_seriesId: string, updated: ConversationFile) => {
    file = structuredClone(updated)
  })
  const host = { current: { readConversation, saveConversation } } as unknown as LibraryHost
  return { host, getFile: () => file, readConversation, saveConversation }
}

describe('autonomous Roundtable runner', () => {
  it('runs every stage, checkpointing posts and peer-only ballots without further user input', async () => {
    const fixtureData = fixture()
    const ai = {
      prepareRoundtable: vi.fn(async () => ({ text: 'Grounded story context', sources: ['Chapter 1'], preparedAt: '2026-11-06T12:00:00.000Z' })),
      reviewRoundtable: vi.fn(async () => null),
      roundtableTurn: vi.fn(async ({ session, speakerId }: {
        session: RoundtableSession; speakerId: string
      }) => {
        const ranking = session.phase === 'vote' ?
          session.participants.filter((p) => p.id !== speakerId).map((p) => p.id) : null
        return { text: 'A reasoned contribution', ranking, ...(session.phase === 'final' ? { summary: 'A short, clear final proposal' } : {}) }
      }),
      cancel: vi.fn(),
    } as unknown as AiService
    let done!: (status: RoundtableRunStatus) => void
    const finished = new Promise<RoundtableRunStatus>((resolve) => { done = resolve })
    const runner = new RoundtableRunner(fixtureData.host, ai, (status) => {
      if (status.state === 'complete' || status.state === 'failed') done(status)
    })
    runner.start('ser_0123456789abcdef', 'cnv_0123456789abcdef')
    const status = await finished
    expect(status.state).toBe('complete')
    const output = fixtureData.getFile().roundtable!
    expect(output.phase).toBe('complete')
    expect(output.posts.filter((p) => p.channel === 'open')).toHaveLength(9)
    expect(output.posts.filter((p) => p.channel === 'direct')).toHaveLength(6)
    expect(output.posts.filter((p) => p.channel === 'private')).toHaveLength(6)
    expect(output.posts.filter((p) => p.phase === 'final' && !!p.summary)).toHaveLength(3)
    expect(output.briefing?.sources).toEqual(['Chapter 1'])
    expect(output.figureheadReviews).toEqual(['discussion1', 'discussion2'])
    expect(output.posts.filter((p) => p.channel === 'ballot')).toHaveLength(3)
    expect(fixtureData.saveConversation).toHaveBeenCalledTimes(32)
    expect((ai.roundtableTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(24)
  })

  it('does not save an in-flight response after a pause', async () => {
    const fixtureData = fixture()
    let release!: (value: { text: string; ranking: null }) => void
    const deferred = new Promise<{ text: string; ranking: null }>((resolve) => { release = resolve })
    const ai = {
      prepareRoundtable: vi.fn(async () => ({ text: 'Grounded story context', sources: [], preparedAt: '2026-11-06T12:00:00.000Z' })),
      reviewRoundtable: vi.fn(async () => null),
      roundtableTurn: vi.fn(() => deferred),
      cancel: vi.fn(),
    } as unknown as AiService
    let pauseDone!: () => void
    const paused = new Promise<void>((resolve) => { pauseDone = resolve })
    const runner = new RoundtableRunner(fixtureData.host, ai, (status) => {
      if (status.state === 'paused') pauseDone()
    })
    const started = runner.start('ser_0123456789abcdef', 'cnv_0123456789abcdef')
    expect(started.state).toBe('running')
    await Promise.resolve()
    await Promise.resolve()
    const stopping = runner.pause('ser_0123456789abcdef', 'cnv_0123456789abcdef')
    expect(stopping.state).toBe('pausing')
    release({ text: 'Late reply', ranking: null })
    await paused
    expect(fixtureData.getFile().roundtable!.posts).toHaveLength(0)
  })
})
