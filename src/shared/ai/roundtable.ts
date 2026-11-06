/** Roundtable state and deterministic progression, shared between UI and main process. */
import { z } from 'zod'

export const roundtablePhaseSchema = z.enum([
  'proposals', 'discussion1', 'revision', 'discussion2', 'final', 'vote', 'complete',
])
export type RoundtablePhase = z.infer<typeof roundtablePhaseSchema>

export const roundtableParticipantSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
  kind: z.enum(['regular', 'specialist', 'guest']),
})
export type RoundtableParticipant = z.infer<typeof roundtableParticipantSchema>

export const roundtablePostSchema = z.object({
  id: z.string().min(1).max(100),
  at: z.iso.datetime(),
  phase: roundtablePhaseSchema,
  speakerId: z.string().min(1).max(80),
  targetId: z.string().max(80).nullable(),
  channel: z.enum(['open', 'direct', 'private', 'ballot', 'user']),
  text: z.string().max(16000),
  /** Sealed final proposal summary, authored by this participant. */
  summary: z.string().trim().max(1800).optional(),
  /** Ballots list other participants in preference order. */
  ranking: z.array(z.string().max(80)).optional(),
})
export type RoundtablePost = z.infer<typeof roundtablePostSchema>

export const roundtableSessionSchema = z.object({
  topic: z.string().trim().min(1).max(4000),
  participants: z.array(roundtableParticipantSchema).min(2).max(12),
  /** Figurehead's curated grounding, gathered from the actual project before proposals. */
  briefing: z.object({
    text: z.string().max(24000),
    sources: z.array(z.string().max(300)).max(80),
    preparedAt: z.iso.datetime(),
  }).optional(),
  /** Moderator notices based on checked manuscript context. */
  interventions: z.array(z.object({
    at: z.iso.datetime(),
    phase: roundtablePhaseSchema,
    text: z.string().max(2500),
  })).max(100).optional(),
  phase: roundtablePhaseSchema,
  posts: z.array(roundtablePostSchema).max(250),
})
export type RoundtableSession = z.infer<typeof roundtableSessionSchema>

export const PHASES: readonly RoundtablePhase[] = [
  'proposals', 'discussion1', 'revision', 'discussion2', 'vote', 'complete',
]

export const PHASE_NAMES: Record<RoundtablePhase, string> = {
  proposals: 'Proposals & criteria',
  discussion1: 'First discussion',
  revision: 'Private reconsideration',
  discussion2: 'Second discussion',
  final: 'Final positions',
  vote: 'Rankings',
  complete: 'Results',
}

export function nextParticipant(session: RoundtableSession): RoundtableParticipant | null {
  if (session.phase === 'complete') return null
  const channel = session.phase === 'revision' || session.phase === 'final' ? 'private' : session.phase === 'vote' ? 'ballot' : 'open'
  const heard = new Set(session.posts
    .filter((post) => post.phase === session.phase && post.channel === channel)
    .map((post) => post.speakerId))
  return session.participants.find((p) => !heard.has(p.id)) ?? null
}

export function phaseIsReady(session: RoundtableSession): boolean {
  return session.phase !== 'complete' && nextParticipant(session) === null
}

export function advancePhase(session: RoundtableSession): RoundtableSession {
  if (!phaseIsReady(session)) throw new Error('All participants must contribute before advancing.')
  const index = PHASES.indexOf(session.phase)
  return { ...session, phase: PHASES[index + 1] ?? 'complete' }
}

export function validBallot(session: RoundtableSession, voterId: string, ranked: string[]): boolean {
  if (!session.participants.some((p) => p.id === voterId)) return false
  const others = session.participants.filter((p) => p.id !== voterId).map((p) => p.id)
  return ranked.length === others.length && new Set(ranked).size === others.length &&
    others.every((id) => ranked.includes(id))
}

/** Final proposals are sealed until all participants have submitted. */
export function finalPositionsReady(session: RoundtableSession): boolean {
  const sealed = session.posts.filter((p) => p.phase === 'final' && p.channel === 'private' &&
    !!p.summary?.trim() && !!p.text.trim())
  return session.participants.every((p) => sealed.some((submission) => submission.speakerId === p.id))
}

export function finalPosition(session: RoundtableSession, participantId: string): RoundtablePost | null {
  return session.posts.find((p) => p.phase === 'final' && p.channel === 'private' &&
    p.speakerId === participantId && !!p.summary?.trim()) ?? null
}

/** Weighted Borda count. No self votes; ties remain ties. */
export function roundtableResults(session: RoundtableSession): { id: string; name: string; score: number; votes: number }[] {
  const totals = new Map(session.participants.map((p) => [p.id, { id: p.id, name: p.name, score: 0, votes: 0 }]))
  const ballots = session.posts.filter((p) => p.phase === 'vote' && p.channel === 'ballot' &&
    p.ranking && validBallot(session, p.speakerId, p.ranking))
  const seen = new Set<string>()
  for (const ballot of ballots) {
    if (seen.has(ballot.speakerId)) continue
    seen.add(ballot.speakerId)
    const ranked = ballot.ranking!
    ranked.forEach((id, rank) => {
      const result = totals.get(id)!
      result.score += ranked.length - rank
      result.votes++
    })
  }
  return [...totals.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}
