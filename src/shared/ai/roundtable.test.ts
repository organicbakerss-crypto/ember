import { describe, expect, it } from 'vitest'
import { ROUNDTABLE_CAST, roundtableRole, SPECIALIST_PROFILES } from './roundtableCast'
import { GUESTS } from './personas'
import { conversationFileSchema } from '../schema'
import {
  advancePhase,
  finalPosition,
  finalPositionsReady,
  nextParticipant,
  phaseIsReady,
  roundtableResults,
  roundtableSessionSchema,
  validBallot,
  type RoundtableSession,
  type RoundtablePost,
} from './roundtable'

const people = [
  { id: 'john-ai', name: 'John AI', kind: 'regular' as const },
  { id: 'roman', name: 'Roman', kind: 'regular' as const },
  { id: 'bo', name: 'Bo', kind: 'regular' as const },
]
const post = (
  speakerId: string,
  phase: RoundtablePost['phase'],
  channel: RoundtablePost['channel'],
  ranking?: string[],
): RoundtablePost => ({
  id: `post-${speakerId}-${phase}-${channel}`,
  at: '2026-11-06T12:00:00.000Z',
  phase,
  speakerId,
  targetId: null,
  channel,
  text: 'A contribution',
  ...(ranking ? { ranking } : {}),
})
const initial = (): RoundtableSession => ({
  topic: 'What should the third act do?',
  phase: 'proposals',
  participants: people,
  posts: [],
})

describe('Roundtable phase engine', () => {
  it('seats the brainstorming partners, the specialists and the guest stars', () => {
    expect(ROUNDTABLE_CAST.filter((role) => role.kind === 'regular')).toHaveLength(11)
    expect(ROUNDTABLE_CAST.filter((role) => role.kind === 'specialist')).toHaveLength(5)
    expect(ROUNDTABLE_CAST.filter((role) => role.kind === 'guest')).toHaveLength(11)
    expect(roundtableRole('nora', 'regular').instructions).toContain('You are Nora')
    for (const guest of GUESTS) {
      const role = roundtableRole(guest.id, 'guest')
      expect(role.instructions).toContain(`AI portrayal of ${guest.name}`)
      for (const other of GUESTS) {
        if (other.id !== guest.id) expect(role.instructions).not.toContain(other.sounds[0]!)
      }
    }
  })

  it('still opens an old session whose character was retired', () => {
    expect(roundtableRole('retired-character', 'regular').instructions).toContain('You are Nora')
    expect(() => roundtableRole('specialist-unknown', 'specialist')).toThrow()
  })

  it('registers five distinct specialist methods, identities and conversational voices', () => {
    expect(SPECIALIST_PROFILES.map((p) => p.name)).toEqual([
      'Fantasy',
      'Science Fiction',
      'Horror',
      'Mystery',
      'Comedy',
    ])
    expect(new Set(SPECIALIST_PROFILES.map((p) => p.method)).size).toBe(5)
    expect(new Set(SPECIALIST_PROFILES.map((p) => p.voice)).size).toBe(5)
    for (const profile of SPECIALIST_PROFILES) {
      const role = roundtableRole(profile.id, 'specialist')
      expect(role.instructions).toContain(`You are the ${profile.name} specialist`)
      expect(role.instructions).toContain(profile.personality)
      expect(role.instructions).toContain(profile.method)
      expect(role.instructions).toContain(profile.voice)
      expect(role.instructions).toContain(profile.bias)
      expect(role.instructions).toContain('That third one is sneaky.')
      expect(role.instructions).toContain('answer yes')
      for (const other of SPECIALIST_PROFILES) {
        if (other.id !== profile.id) expect(role.instructions).not.toContain(other.method)
      }
    }
    expect(() => roundtableRole('specialist-romance', 'specialist')).toThrow()
  })

  it('mixes a specialist with regular characters in valid peer ballots', () => {
    const participants = [
      people[0]!,
      { id: 'specialist-fantasy', name: 'Fantasy', kind: 'specialist' as const },
      people[1]!,
    ]
    const session = { ...initial(), phase: 'vote' as const, participants }
    expect(validBallot(session, 'specialist-fantasy', ['john-ai', 'roman'])).toBe(true)
    expect(validBallot(session, 'specialist-fantasy', ['specialist-fantasy', 'john-ai'])).toBe(
      false,
    )
    expect(roundtableRole('specialist-fantasy', 'specialist').name).toBe('Fantasy')
  })

  it('persists the full session in the existing conversation schema', () => {
    const now = '2026-11-06T12:00:00.000Z'
    const file = conversationFileSchema.parse({
      formatVersion: 1,
      id: 'cnv_0123456789abcdef',
      mode: 'chat',
      characterId: 'john-ai',
      title: 'Roundtable',
      createdAt: now,
      updatedAt: now,
      messages: [],
      roundtable: initial(),
    })
    expect(file.roundtable?.participants).toHaveLength(3)
    expect(file.roundtable?.phase).toBe('proposals')
  })

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
    for (const phase of [
      'proposals',
      'discussion1',
      'revision',
      'discussion2',
      'final',
      'vote',
    ] as const) {
      expect(state.phase).toBe(phase)
      const channel =
        phase === 'revision' || phase === 'final' ? 'private' : phase === 'vote' ? 'ballot' : 'open'
      for (const p of people) state.posts.push(post(p.id, phase, channel))
      state = advancePhase(state)
    }
    expect(state.phase).toBe('complete')
    expect(nextParticipant(state)).toBeNull()
  })

  it('accepts up to twelve participants, but not thirteen', () => {
    const participants = Array.from({ length: 12 }, (_, i) => ({
      id: `participant-${i}`,
      name: `Participant ${i}`,
      kind: 'specialist' as const,
    }))
    expect(roundtableSessionSchema.safeParse({ ...initial(), participants }).success).toBe(true)
    expect(
      roundtableSessionSchema.safeParse({
        ...initial(),
        participants: [
          ...participants,
          {
            id: 'participant-12',
            name: 'Participant 12',
            kind: 'specialist',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('keeps final positions sealed until all summaries and proposals are locked in', () => {
    const session = { ...initial(), phase: 'final' as const }
    expect(finalPositionsReady(session)).toBe(false)
    for (const participant of people) {
      session.posts.push({
        ...post(participant.id, 'final', 'private'),
        summary: `Final ${participant.name}`,
      })
    }
    expect(finalPositionsReady(session)).toBe(true)
    expect(finalPosition(session, 'roman')?.summary).toBe('Final Roman')
    expect(advancePhase(session).phase).toBe('vote')
  })

  it('rejects self votes, duplicates, omissions and foreign candidates', () => {
    const state = { ...initial(), phase: 'vote' as const }
    expect(validBallot(state, 'roman', ['bo', 'john-ai'])).toBe(true)
    expect(validBallot(state, 'roman', ['roman', 'bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo', 'bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo'])).toBe(false)
    expect(validBallot(state, 'roman', ['bo', 'unknown'])).toBe(false)
    expect(validBallot(state, 'stranger', ['bo', 'john-ai', 'roman'])).toBe(false)
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
