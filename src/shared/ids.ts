/**
 * Stable, permanent IDs for every library item.
 *
 * Links always use these, never names. The prefix is only there so a human
 * reading the files can tell what an ID points at.
 */

export const ID_KINDS = {
  series: 'ser',
  volume: 'vol',
  arc: 'arc',
  chapter: 'chp',
  world: 'wld',
  entry: 'ent',
  category: 'cat',
  section: 'sec',
  event: 'evt',
  library: 'lib',
  trash: 'trs',
  fact: 'fct',
  quote: 'quo',
  field: 'fld',
  template: 'tpl',
  inbox: 'inb',
  map: 'map',
  region: 'rgn',
  pin: 'pin',
  relationship: 'rel',
} as const

export type IdKind = keyof typeof ID_KINDS

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford base32, lowercase
const RANDOM_LENGTH = 16 // 80 bits

export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(RANDOM_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte & 31]
  return `${ID_KINDS[kind]}_${out}`
}

/** Matches an ID of the given kind. IDs end up in file paths, so this is strict. */
export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_KINDS[kind]}_[${ALPHABET}]{${RANDOM_LENGTH}}$`)
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && idPattern(kind).test(value)
}
