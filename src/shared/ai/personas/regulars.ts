import type { RegularPersona } from './types'

/**
 * The everyday partner: John AI, a plain assistant. (The other partners were
 * retired in Nov 2026; conversations with them carry on with John AI.)
 */
export const REGULARS: readonly RegularPersona[] = [
  {
    kind: 'regular',
    id: 'john-ai',
    name: 'John AI',
    plain: true,
    summary: 'A plain assistant, no personality. For when you don’t want a character.',
    loves: [],
    cantStand: [],
    believes: [],
    bias: '',
    approach: '',
    example: '',
    voice: 'Plain and helpful.',
    sounds: [],
  },
]
