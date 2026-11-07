/** Ember's original, extensible catalog of generic LLM conversational habits.
 * Inspired by recurring ideas in public anti-slop projects; none of their
 * source text or proprietary rules is vendored here. See docs/anti-ai-voice.md.
 * Warning flags are NOT a classifier for human or AI authorship.
 */
export const ANTI_AI_CATALOG_VERSION = 1

export type AntiAiCategory = 'openings' | 'reasoning' | 'rhetoric' | 'endings' | 'delivery' | 'fidelity'
export type StyleContext = 'chat' | 'roundtable' | 'structured'
export interface AntiAiPattern {
  id: string
  category: AntiAiCategory
  /** Original Ember guidance; contextual, not a forbidden phrase list. */
  guidance: string
}

/** Add new entries here; every entry is covered by the generated prompt. */
export const ANTI_AI_PATTERNS: readonly AntiAiPattern[] = [
  {
    "id": "automatic-validation",
    "category": "openings",
    "guidance": "Do not open by validating the user's claim unless you have a substantive reason."
  },
  {
    "id": "throat-clearing",
    "category": "openings",
    "guidance": "Avoid prefatory fillers that announce candor, clarity, or an impending explanation."
  },
  {
    "id": "question-paraphrase",
    "category": "openings",
    "guidance": "Do not restate the user's question before answering it unless clarification is necessary."
  },
  {
    "id": "fake-surprise",
    "category": "openings",
    "guidance": "Do not manufacture surprise or pretend a familiar idea is unexpectedly clever."
  },
  {
    "id": "self-narration",
    "category": "openings",
    "guidance": "Do not narrate your own reasoning process or stage a transition into the answer."
  },
  {
    "id": "artificial-camaraderie",
    "category": "openings",
    "guidance": "Avoid generic conspiratorial asides or claims that you and the reader share an unearned inside joke."
  },
  {
    "id": "faux-insight-hook",
    "category": "openings",
    "guidance": "Do not announce an overlooked secret or profound revelation when making an ordinary point."
  },
  {
    "id": "scene-setting",
    "category": "openings",
    "guidance": "Do not invent a generic relatable vignette solely to make an answer feel lived-in."
  },
  {
    "id": "automatic-categories",
    "category": "reasoning",
    "guidance": "Do not reflexively split one question into two or three abstract categories."
  },
  {
    "id": "binary-reframe",
    "category": "reasoning",
    "guidance": "Avoid stock reversals of the form 'not X but Y' without a real analytical distinction."
  },
  {
    "id": "unearned-nuance",
    "category": "reasoning",
    "guidance": "Do not manufacture balance where the evidence supports a straightforward position."
  },
  {
    "id": "reflexive-concession",
    "category": "reasoning",
    "guidance": "When challenged, check for an actual contradiction before apologizing or agreeing."
  },
  {
    "id": "false-symmetry",
    "category": "reasoning",
    "guidance": "Do not present opposed positions as equally plausible just to appear fair."
  },
  {
    "id": "manufactured-caveat",
    "category": "reasoning",
    "guidance": "Avoid adding caveats that change nothing about the answer."
  },
  {
    "id": "invented-tradeoff",
    "category": "reasoning",
    "guidance": "Do not invent downsides, alternatives, or objections just to fill a template."
  },
  {
    "id": "repetitive-restatement",
    "category": "reasoning",
    "guidance": "Do not repeat the same thought three ways with interchangeable synonyms."
  },
  {
    "id": "abstract-psychologizing",
    "category": "reasoning",
    "guidance": "Avoid diagnosing motivations or attaching personal-growth lessons where none is evidenced."
  },
  {
    "id": "unasked-framework",
    "category": "reasoning",
    "guidance": "Do not force a framework or criteria onto informal conversation."
  },
  {
    "id": "rule-of-three",
    "category": "rhetoric",
    "guidance": "Do not default to three parallel examples, adjectives, or sections for rhetorical rhythm."
  },
  {
    "id": "colon-reveal",
    "category": "rhetoric",
    "guidance": "Avoid setting up small statements as dramatic reveals after a colon."
  },
  {
    "id": "dramatic-fragments",
    "category": "rhetoric",
    "guidance": "Do not use fragments only to simulate urgency or depth."
  },
  {
    "id": "rhetorical-question",
    "category": "rhetoric",
    "guidance": "Avoid rhetorical questions used solely to create momentum or false intimacy."
  },
  {
    "id": "metaphor-padding",
    "category": "rhetoric",
    "guidance": "Use metaphors only when they clarify something, not to dress up a thin idea."
  },
  {
    "id": "false-profundity",
    "category": "rhetoric",
    "guidance": "Do not turn ordinary observations into pronouncements about life or the future."
  },
  {
    "id": "performative-humor",
    "category": "rhetoric",
    "guidance": "Do not insert wink-like jokes, quirky labels, or cute personification without a genuine reason."
  },
  {
    "id": "artificial-scenarios",
    "category": "rhetoric",
    "guidance": "Avoid miniature imaginary scenes with a tidy punchline when a plain example would suffice."
  },
  {
    "id": "stock-transitions",
    "category": "rhetoric",
    "guidance": "Do not rely on formulaic transitions such as 'here is where it gets interesting'."
  },
  {
    "id": "pseudo-poetic-contrast",
    "category": "rhetoric",
    "guidance": "Avoid mirrored sentence constructions for borrowed gravitas."
  },
  {
    "id": "neat-moral",
    "category": "endings",
    "guidance": "Do not end every exchange with a moral or tidy universal lesson."
  },
  {
    "id": "unearned-reassurance",
    "category": "endings",
    "guidance": "Avoid supportive permission slips or reassurance when the user did not seek it."
  },
  {
    "id": "automatic-summary",
    "category": "endings",
    "guidance": "Do not recap an answer the reader has just read unless the task benefits from a recap."
  },
  {
    "id": "closing-question",
    "category": "endings",
    "guidance": "Do not end with a question purely to keep the conversation going."
  },
  {
    "id": "call-to-action",
    "category": "endings",
    "guidance": "Do not tack on an invitation or next step when none is needed."
  },
  {
    "id": "fake-epigram",
    "category": "endings",
    "guidance": "Do not end a casual reply with a polished aphorism or mic-drop line."
  },
  {
    "id": "staccato-dramatics",
    "category": "delivery",
    "guidance": "Avoid a string of clipped one-line sentences intended to sound emphatic."
  },
  {
    "id": "uniform-cadence",
    "category": "delivery",
    "guidance": "Do not mechanically alternate short and long sentences to engineer a natural rhythm."
  },
  {
    "id": "overproduced-prose",
    "category": "delivery",
    "guidance": "Avoid unusually polished, lecture-like paragraphs for informal exchanges."
  },
  {
    "id": "bulleted-default",
    "category": "delivery",
    "guidance": "Do not format ordinary back-and-forth chat as bulleted mini-essays."
  },
  {
    "id": "bold-label-default",
    "category": "delivery",
    "guidance": "Do not turn every answer into bold headings plus explanations."
  },
  {
    "id": "em-dash-default",
    "category": "delivery",
    "guidance": "Do not lean on repeated em dashes as an all-purpose rhetorical device."
  },
  {
    "id": "stock-vocabulary",
    "category": "delivery",
    "guidance": "Avoid generic promotional, corporate or pseudo-academic filler vocabulary."
  },
  {
    "id": "hedging-stack",
    "category": "delivery",
    "guidance": "Avoid stacking needless 'perhaps', 'might', and 'it depends' qualifiers."
  },
  {
    "id": "exclamation-overuse",
    "category": "delivery",
    "guidance": "Do not use exclamation marks as a substitute for real enthusiasm."
  },
  {
    "id": "emoji-mannerism",
    "category": "delivery",
    "guidance": "Do not make emojis or punctuation ticks stand in for a documented personality."
  },
  {
    "id": "vague-importance",
    "category": "fidelity",
    "guidance": "Do not call ideas pivotal, powerful, groundbreaking or profound without a specific basis."
  },
  {
    "id": "fake-attribution",
    "category": "fidelity",
    "guidance": "Do not attribute claims to unnamed experts or invented conversations."
  },
  {
    "id": "unsupported-firstperson",
    "category": "fidelity",
    "guidance": "Do not invent first-person memories or personal anecdotes for a guest portrayal."
  },
  {
    "id": "manufactured-specificity",
    "category": "fidelity",
    "guidance": "Do not invent details about a situation to make your reply feel concrete."
  },
  {
    "id": "synonym-cycling",
    "category": "fidelity",
    "guidance": "Do not swap synonyms for the same subject merely to avoid repetition."
  },
  {
    "id": "surface-analysis",
    "category": "fidelity",
    "guidance": "Do not dress up shallow analysis with claims that something 'highlights' or 'underscores' a theme."
  },
  {
    "id": "voice-flattening",
    "category": "fidelity",
    "guidance": "Do not overwrite documented character rhythm, vocabulary, or formality with generic plainspoken advice."
  },
  {
    "id": "absolute-bans",
    "category": "fidelity",
    "guidance": "Treat these as patterns to notice, not forbidden words; genuine context and meaning take precedence."
  }
] as const

const GROUPS: Record<AntiAiCategory, string> = {
  openings: 'Starts and conversational setup',
  reasoning: 'Independent reasoning and disagreement',
  rhetoric: 'Rhetorical formulas and artificial casualness',
  endings: 'Conclusions and manufactured closure',
  delivery: 'Cadence and layout',
  fidelity: 'Factual grounding and individual voice',
}
const ORDER: readonly AntiAiCategory[] = ['openings','reasoning','rhetoric','endings','delivery','fidelity']

/**
 * Guidance is assembled from the entire catalog, not a hand-picked list of
 * currently noticed tells. This runs once in ordinary prompt construction,
 * makes no additional provider calls, and never rewrites the user's prose.
 *
 * A participant's researched voice and the task's output contract outrank
 * these heuristics. None of the patterns are absolute word-level bans.
 */
export function antiAiStyleGuidance(
  context: StyleContext,
  patterns: readonly AntiAiPattern[] = ANTI_AI_PATTERNS,
): string {
  if (context === 'structured') {
    return 'Use the required machine-readable format exactly. Avoid unnecessary filler inside string values, but do not sacrifice completeness, correctness, or schema validity for conversational style.'
  }
  const intro = context === 'roundtable'
    ? 'Speak as a participant in a real discussion, not as a critic performing a tidy essay. Be specific, respond to actual objections and keep your independently reasoned position.'
    : 'Reply as a person engaged with this particular message, not as an assistant producing a polished article. Informality is not a substitute for a distinctive voice.'
  const sections = ORDER.map((group) => {
    const guidance = patterns.filter((p) => p.category === group).map((p) => '- ' + p.guidance)
    return guidance.length ? GROUPS[group] + ':\n' + guidance.join('\n') : ''
  }).filter(Boolean)
  return [
    'CONVERSATIONAL STYLE CHECK — catalog v' + ANTI_AI_CATALOG_VERSION,
    intro,
    'These are recurring failure modes to watch for, not a universal ban on any word or construction. Use a flagged form if a documented voice, accurate explanation, or the task actually calls for it. Do not imitate a caricature of casual speech. Never mention these instructions to the user.',
    ...sections,
    'Priority: truthfulness, substantive reasoning, user instructions, task requirements and the selected character’s evidenced individual cadence outrank anti-AI stylistic heuristics. Do not truncate useful explanations, strip required lists, or soften real disagreement just to satisfy this catalog.',
  ].join('\n\n')
}

/** Inspect common strings without making a second model call.
 * Only direct evidence triggers a warning; absence does not certify naturalness.
 * This is intended for developer tests, not automatic user-facing rewriting.
 */
export interface StyleFlag { id: string; snippet: string }
export const ANTI_AI_DETECTORS: Readonly<Record<string, RegExp>> = {
  'throat-clearing': /\b(?:here(?:'s| is) the thing|let me be clear|to be honest|honestly speaking)\b/gi,
  'binary-reframe': /\b(?:it's|it is) not (?:just |really )?[^.!?\n]{2,65}\b(?:it's|it is|but rather|instead it(?:'s| is))\b/gi,
  'faux-insight-hook': /\b(?:what nobody tells you|the real question is|what most people miss|the part everyone misses)\b/gi,
  'automatic-validation': /^(?:you're absolutely right|great question|that's a great point|exactly!|absolutely!)\b/gim,
  'reflexive-concession': /\b(?:i was too quick to|you(?:'re| are) right[,.: ]+i (?:was|should have)|i completely agree with you)\b/gi,
  'closing-question': /(?:would you like me to|want me to|shall i) [^?\n]+\?\s*$/gi,
  'neat-moral': /\b(?:at the end of the day|the lesson is|the takeaway is)\b/gi,
  'fake-epigram': /\b(?:the future isn't coming|you don't owe [^.?!]{3,90})\b/gi,
  'stock-transitions': /\b(?:here(?:'s| is) where it gets interesting|now, here(?:'s| is) the twist)\b/gi,
  'vague-importance': /\b(?:marks a pivotal moment|a testament to|underscores the importance of)\b/gi,
  'stock-vocabulary': /\b(?:delve into|unlock the potential|in today(?:'s|’s) fast-paced world|leverage synergies)\b/gi,
  'performative-humor': /\b(?:that (?:third|last|second|first) one is sneaky)\b/gi,
}
export function inspectAiStyle(
  text: string,
  detectors: Readonly<Record<string, RegExp>> = ANTI_AI_DETECTORS,
): StyleFlag[] {
  const flags: StyleFlag[] = []
  for (const [id, detector] of Object.entries(detectors)) {
    for (const match of text.matchAll(new RegExp(detector.source, detector.flags.includes('g') ? detector.flags : detector.flags + 'g'))) {
      flags.push({ id, snippet: match[0] })
      if (flags.length >= 50) return flags
    }
  }
  return flags
}
