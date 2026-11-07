/** Real Q&A construction patterns, not personality adjectives.
 * This module does not infer exact English phrasing from edited Japanese text.
 */
import type { GuestSituation } from './evidence'

export interface InterviewExchange {
  id: string
  situation: 'casual' | 'social' | 'uncertainty' | 'disagreement' | 'creative'
  topic: readonly string[]
  /** Faithful summary of the interviewer's actual question, not a verbatim translation. */
  question: string
  /** Ordered stages directly observed in the published answer. */
  moves: readonly string[]
  /** Small verified fragment of his published Japanese answer, or null. */
  quote: string | null
  source: string
  anchor: string
  language: 'ja'
  medium: 'edited-written-interview'
}

const WORDS = (value: string): string[] =>
  value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
const CATEGORY: Record<GuestSituation, readonly InterviewExchange['situation'][]> = {
  casual: ['casual', 'social', 'uncertainty'],
  creative: ['creative', 'disagreement', 'casual'],
  disagreement: ['disagreement', 'social', 'uncertainty', 'creative'],
  uncertainty: ['uncertainty', 'social', 'casual'],
  final: ['creative', 'disagreement', 'uncertainty'],
  vote: ['creative', 'disagreement', 'uncertainty'],
}
const SEED = (text: string): number => [...text].reduce((n,c)=>(n*33+c.charCodeAt(0))>>>0, 5381)

/** Select different real Q&A answer sequences rather than repeating one tic. */
export function selectInterviewExchanges(
  exchanges: readonly InterviewExchange[], situation: GuestSituation, question: string,
  max = 4,
): InterviewExchange[] {
  const budget = Math.min(5, Math.max(0, Math.trunc(max)))
  if (!budget || !exchanges.length) return []
  const relevant = CATEGORY[situation]
  const tokens = new Set(WORDS(question))
  const seed = SEED(situation + ':' + question.toLowerCase())
  const scored = exchanges.map((exchange, i) => {
    const topic = exchange.topic.join(' ').toLowerCase()
    const overlap = [...tokens].reduce((n, word) => n + (topic.includes(word) ? 1 : 0), 0)
    return { exchange, index:i, score: overlap * 8 + (relevant.includes(exchange.situation) ? 4 : 0) }
  }).sort((a,b)=>b.score-a.score || (a.index+seed)%exchanges.length-(b.index+seed)%exchanges.length)
  const selected: InterviewExchange[] = []
  const seen = new Set<string>()
  const add = (candidates: typeof scored, uniqueSituation = true) => {
    for (const { exchange } of candidates) {
      if (selected.length >= budget) return
      if (selected.includes(exchange)) continue
      if (uniqueSituation && seen.has(exchange.situation)) continue
      selected.push(exchange)
      seen.add(exchange.situation)
    }
  }
  // Independent of the topic, give one ordinary-life or social exchange as
  // an example of how he answers outside the craft subject.
  const ordinary = scored.filter((x) => x.exchange.situation === 'casual' || x.exchange.situation === 'social')
  const rotated = [...ordinary.slice(seed % (ordinary.length || 1)), ...ordinary.slice(0,seed % (ordinary.length || 1))]
  add(rotated.slice(0,1))
  add(scored)
  add(scored,false)
  // Every live prompt must include at least one actual original-language
  // sentence fragment, not only our paraphrase of the answer's structure.
  if (selected.length && !selected.some((item) => item.quote)) {
    const quoted = scored.find(({ exchange }) => !!exchange.quote && !selected.includes(exchange))
    if (quoted) selected[selected.length - 1] = quoted.exchange
  }
  return selected
}

/**
 * A question-response worked example: a real prompt + answer's consecutive
 * rhetorical moves + tiny actual Japanese fragment. Unlike the old library,
 * this preserves the question-to-answer syntax and sequencing relationships.
 */
export function interviewSpeechPrompt(
  exchanges: readonly InterviewExchange[], situation: GuestSituation, question: string,
): string {
  const samples = selectInterviewExchanges(exchanges,situation,question)
  if (!samples.length) return ''
  return [
    'DOCUMENTED CONVERSATION CONSTRUCTION — REAL QUESTION/ANSWER PAIRS',
    'These are verified patterns of how this guest developed answers in published interviews. The interviewer question is a faithful English paraphrase. The numbered answer movements describe his actual published response, IN ORDER; they are not dialogue to quote or a newly invented reply. Only the Japanese fragment marked VERBATIM was actually quoted. Use the variation in answer structures and lengths as examples for constructing your own answer. They are not a fixed four-step template.',
    'Important: published Japanese Q&A may be edited; do not mimic Japanese grammar in English, reproduce quotations or fabricate memories. This does not prove his precise spoken English cadence. Some answers were a single sentence. Some expanded organically. Match the question, not an artificial desire for balanced commentary or a closing aphorism. Let this evidence override generic style heuristics when they conflict.',
    ...samples.map((entry,i)=>[
      `Q&A ${i+1}: ${entry.anchor} [${entry.situation}, ${entry.medium}]`,
      `INTERVIEWER ASKED (paraphrase): ${entry.question}`,
      'ACTUAL ANSWER CONSTRUCTION (successive moves):',
      ...entry.moves.map((move,n)=>`  ${n+1}. ${move}`),
      ...(entry.quote ? [`VERBATIM JAPANESE FRAGMENT (not English speech): ${entry.quote}`] : []),
      `SOURCE: ${entry.source}`,
    ].join('\n')),
  ].join('\n\n')
}
