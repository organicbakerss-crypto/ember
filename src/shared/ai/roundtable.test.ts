import { describe, expect, it } from 'vitest'
import {
  advancePhase, nextParticipant, phaseIsReady, roundtableResults, validBallot,
  type RoundtableSession, type RoundtablePost,
} from './roundtable'

const people = [
  { id: 'john-ai', name: 'John AI', kind: 'regular' as const },
  { id: 'roman', name: 'Roman', kind: 'regular' as const },
  { id: 'bo', name: 'Bo', kind: 'regular' as const },
]
const post = (speakerId: string, phase: RoundtablePost['phase'],
  channel: RoundtablePost['channel'], ranking?: string[]): RoundtablePost => ({
  id: `post-${speakerId}-${phase}-${channel}`,
  at: '2026-11-06T12:00:00.000Z', phase, speakerId, targetId: null,
  channel, text: 'A contribution', ...(ranking ? { ranking } : {}),
})
const initial = (): RoundtableSession => ({
  topic: 'What should the third act do?',
  phase: 'proposals', participants: people, posts: [],
})

describe('Roundtable phase engine', () => {
  it('requires every participant to propose before discussion starts', () => {
    const state = initial()
    expect(nextParticipant(state)?.id).toBe('john-ai')
    expect(phaseIsReady(state)).toBe(false)
    expect(() => advancePhase(state)).toThrow()
    state.posts.push(post('john-ai', 'proposals', 'open'))
    state.posts.push(post('roman', 'proposals', 'open'))
    expect(nextParticipant(state)?.id).toBe('bo')
    state.posts.push(post('bo', 'proposals', 'open'))
    expect(advancePhase(state).phase).toBe('discussion1')
  })

  it('keeps direct exchanges and writer messages from counting as a scheduled turn', () => {
    const state = { ...initial(), phase: 'discussion1' as const }
    state.posts.push(post('roman', 'discussion1', 'direct'))
    state.posts.push(post('writer', 'discussion1', 'user'))
    expect(nextParticipant(state)?.id).toBe('john-ai')
  })

  it('runs exactly two discussions with private reconsideration before voting', () => {
    let state = initial()
    for (const phase of ['proposals', 'discussion1', 'revision', 'discussion2', 'vote'] as const) {
      expect(state.phase).toBe(phase)
      const channel = phase === 'revision' ? 'private' : phase === 'vote' ? 'ballot' : 'open'
      for (const p of people) state.posts.push(post(p.id, phase, channel))
      state = advancePhase(state)
    }
    expect(state.phase).toBe('complete')
    expect(nextParticipant(state)).toBeNull()
  })

  it('rejects self votes, duplicates, omissions and foreign candidates', () => {
    const state = { ...initial(), phase: 'vote' as const }
    expect(validBallot(state, 'roman', ['bo', 'john-ai'])).toBe(true)
    expect(validBallot(state, 'roman', ['roman', 'bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo', 'bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo', 'unknown'])).toBe(false)
  })

  it('counts one valid ballot per voter and exposes all score totals', () => {
    const state = { ...initial(), phase: 'complete' as const }
    state.posts.push(
      post('john-ai', 'vote', 'ballot', ['roman', 'bo']),
      post('roman', 'vote', 'ballot', ['bo', 'john-ai']),
      post('bo', 'vote', 'ballot', ['roman', 'john-ai']),
      post('john-ai', 'vote', 'ballot', ['bo', 'roman']),
      post('bo', 'vote', 'ballot', ['bo', 'john-ai']),
    )
    const results = roundtableResults(state)
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ id: 'roman', score: 4, votes: 2 })
    expect(results[1]).toMatchObject({ id: 'bo', score: 3, votes: 2 })
    expect(results[2]).toMatchObject({ id: 'john-ai', score: 2, votes: 2 })
  })
})
