/**
 * A first guess at what kind of thing a new name is, from the name itself and
 * the words just before it ("sailed into Gullhaven" → a place). Only a
 * default for the Add dialog; the writer always picks.
 */
const BY_WORD: [RegExp, string][] = [
  [/\b(kingdom|empire|realm|republic|duchy|province|dominion)\b/i, 'kingdom'],
  [/\b(continent|land of)\b/i, 'continent'],
  [/\b(district|quarter|ward|market|docks)\b/i, 'district'],
  [
    /\b(forest|wood|woods|mountains?|river|sea|lake|marsh|desert|wastes?|moor|vale|valley|hills?)\b/i,
    'wilds',
  ],
  [/\b(tower|temple|castle|keep|bridge|gate|shrine|citadel|lighthouse)\b/i, 'landmark'],
  [/\b(city|town|village|port|harbou?r|haven|burg|ford)\b/i, 'city'],
  [
    /\b(guild|order|company|brotherhood|sisterhood|council|church|cult|army|fleet|league|clan)\b/i,
    'faction',
  ],
  [/^house\b/i, 'family'],
  [/\b(war|battle|siege|fall|treaty|rebellion|uprising|massacre|flood|coronation)\b/i, 'event'],
  [/\b(age|era|epoch)\b/i, 'era'],
  [/\b(magic|sorcery|rite|ritual|law|code|faith)\b/i, 'magic'],
]

/** Words before a name that point at a place: "into Gullhaven", "from Saltmere". */
const PLACE_BEFORE =
  /\b(in|into|at|to|from|toward|towards|near|across|through|reached|left|of the city of)\s*$/i

/** The template id to suggest, or null when there's nothing to go on. */
export function guessTemplate(name: string, before = ''): string | null {
  const trimmed = name.trim()
  for (const [pattern, template] of BY_WORD) if (pattern.test(trimmed)) return template
  if (PLACE_BEFORE.test(before.trimEnd() + ' ') || PLACE_BEFORE.test(before.trimEnd()))
    return 'city'
  return null
}
