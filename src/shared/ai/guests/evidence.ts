/** Evidence selection is deterministic, diverse, bounded and offline. */
export interface GuestEvidence {
  id: string
  category: string
  /** Paraphrased observed behavior; not a quote. */
  observation: string
  /** Prompt that elicited the observation, or public writing context. */
  question: string
  sourceUrl: string
  language: 'ja' | 'translated'
  limitations: string
  /** Short, verbatim original-language quotation where verifiable. Never a generated imitation. */
  quote?: string
}

export type GuestSituation = 'casual' | 'creative' | 'disagreement' | 'uncertainty' | 'final' | 'vote'

/** Small multilingual keyword and situation mapping, no embeddings, network, or model calls. */
const TOPICS: Record<GuestSituation, readonly string[]> = {
  casual: ['everyday', 'interests', 'social', 'humor', 'routine', 'friends', 'games', 'tools'],
  creative: ['creative', 'craft', 'characters', 'plot', 'world', 'readability', 'analysis'],
  disagreement: ['uncertainty', 'social', 'reflection', 'limitations', 'character', 'advice'],
  uncertainty: ['uncertainty', 'reflection', 'self-assessment', 'recognition', 'limitations'],
  final: ['creative', 'characters', 'analysis', 'craft', 'plot'],
  vote: ['creative', 'analysis', 'craft', 'uncertainty'],
}
const NORMALIZE = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
const STOP = new Set(['the','and','with','that','this','from','into','what','should','would','about','have','will','story','there','their'])

/** Always reserves several slots for off-topic, ordinary personality evidence. */
export function selectGuestEvidence(
  evidence: readonly GuestEvidence[],
  situation: GuestSituation,
  topic: string,
  max = 5,
): GuestEvidence[] {
  const budget = Math.max(0, Math.min(6, Math.trunc(max)))
  const tokens = new Set(NORMALIZE(topic).filter((token) => !STOP.has(token)))
  const wanted = TOPICS[situation]
  const seed = [...(situation + ':' + topic.toLowerCase())].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0)
  const scored = evidence.map((sample, index) => ({
    sample, index,
    score: (wanted.some((tag) => sample.category.includes(tag) || tag.includes(sample.category)) ? 4 : 0) +
      NORMALIZE(sample.observation + ' ' + sample.question).reduce((score, token) => score + (tokens.has(token) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || ((a.index + seed) % evidence.length) - ((b.index + seed) % evidence.length))
  const selected: GuestEvidence[] = []
  const usedCategories = new Set<string>()
  const usedSources = new Set<string>()
  const take = (list: typeof scored) => {
    for (const item of list) {
      if (selected.length >= budget) return
      if (selected.includes(item.sample)) continue
      if (usedCategories.has(item.sample.category)) continue
      if (usedSources.has(item.sample.sourceUrl)) continue
      selected.push(item.sample)
      usedCategories.add(item.sample.category)
      usedSources.add(item.sample.sourceUrl)
    }
  }
  // Prefer two ordinary conversational samples, even for writing-specific questions.
  const ordinary = scored.filter((x) => ['everyday','humor','interests','social','reflection'].includes(x.sample.category))
  const rotation = ordinary.length ? seed % ordinary.length : 0
  take([...ordinary.slice(rotation), ...ordinary.slice(0, rotation)].slice(0,2))
  take(scored)
  // If diversity exhausts the sources, permit additional samples from the same source.
  if (selected.length < budget) {
    for (const { sample } of scored) {
      if (selected.length >= budget) break
      if (!selected.includes(sample) && !usedCategories.has(sample.category)) {
        selected.push(sample)
        usedCategories.add(sample.category)
      }
    }
  }
  return selected
}

export function guestEvidencePrompt(evidence: readonly GuestEvidence[], situation: GuestSituation, topic: string): string {
  if (!evidence.length) return ''
  const selected = selectGuestEvidence(evidence, situation, topic)
  if (!selected.length) return ''
  return [
    'PUBLIC-EVIDENCE REFERENCE (observations, not dialogue to copy):',
    'Use the behavioral range as a quiet guide. Do not quote the evidence verbatim, claim the person said paraphrased observations, or invent autobiography. Do not mention this reference list unasked.',
    ...selected.map((sample) => [
      `[Reference: ${sample.id}; ${sample.language}; prompt/context: ${sample.question}]`,
      sample.observation,
      sample.quote ? `Brief original-language quote (do not echo): ${sample.quote}` : '',
      `Source: ${sample.sourceUrl}`,
    ].filter(Boolean).join(' ')),
  ].join('\n')
}
