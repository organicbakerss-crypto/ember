/**
 * Built-in entry templates. A template decides which facts an entry offers
 * and which of them show in the quick facts strip; most fields are links to
 * other entries, so later views (map, board, timeline) can draw them.
 * A world can customise these or add its own (saved in the world folder).
 */
import type { Template, TemplateField } from '../schema'

export type Lens = Template['lens']

export const LENS_LABELS: Record<Lens, string> = {
  where: 'Where',
  who: 'Who',
  when: 'When',
  how: 'How',
}

interface FieldSpec {
  id: string
  label: string
  kind: TemplateField['kind']
  quick?: boolean
  multiple?: boolean
  reverse?: string
}

const field = (spec: FieldSpec): TemplateField => ({ quick: false, multiple: false, ...spec })

const placeFields = (): TemplateField[] => [
  field({ id: 'within', label: 'Within', kind: 'link', quick: true, reverse: 'Inside it' }),
  field({ id: 'ruledBy', label: 'Ruled by', kind: 'link', quick: true, reverse: 'Rules' }),
  field({ id: 'population', label: 'Population', kind: 'text', quick: true }),
  field({ id: 'climate', label: 'Climate', kind: 'text', quick: true }),
  field({ id: 'knownFor', label: 'Known for', kind: 'text', quick: true }),
  // A place that splits (or is renamed) becomes new places linked to the old one.
  field({
    id: 'formerly',
    label: 'Formerly part of',
    kind: 'link',
    multiple: true,
    reverse: 'Became',
  }),
]

const systemFields = (): TemplateField[] => [
  field({ id: 'rules', label: 'Rules', kind: 'text', multiple: true }),
  field({ id: 'costs', label: 'Costs', kind: 'text', quick: true }),
  field({ id: 'limits', label: 'Limits', kind: 'text', quick: true }),
  field({
    id: 'usedBy',
    label: 'Who can use it',
    kind: 'link',
    quick: true,
    multiple: true,
    reverse: 'Can use',
  }),
  field({
    id: 'worksIn',
    label: 'Where it works',
    kind: 'link',
    quick: true,
    multiple: true,
    reverse: 'Works here',
  }),
]

const status = () => field({ id: 'status', label: 'Status', kind: 'text', quick: true })
const knownFor = () => field({ id: 'knownFor', label: 'Known for', kind: 'text', quick: true })
const memberOf = (label = 'Member of') =>
  field({ id: 'memberOf', label, kind: 'link', quick: true, multiple: true, reverse: 'Members' })
const home = (label = 'Home') =>
  field({ id: 'home', label, kind: 'link', quick: true, reverse: 'Home to' })
const leader = (label = 'Leader') =>
  field({ id: 'leader', label, kind: 'link', quick: true, reverse: 'Leads' })

export const BUILT_IN_TEMPLATES: readonly Template[] = [
  ...(
    [
      ['continent', 'Continent'],
      ['kingdom', 'Kingdom'],
      ['city', 'City'],
      ['district', 'District'],
      ['landmark', 'Landmark'],
      ['wilds', 'Wilds'],
    ] as const
  ).map(([id, name]): Template => ({ id, name, lens: 'where', fields: placeFields() })),
  {
    id: 'person',
    name: 'Person',
    lens: 'who',
    fields: [
      field({ id: 'role', label: 'Role', kind: 'text', quick: true }),
      status(),
      field({ id: 'location', label: 'Where now', kind: 'link', quick: true, reverse: 'Here now' }),
      memberOf(),
      home(),
      field({ id: 'appearance', label: 'Appearance', kind: 'text' }),
      field({ id: 'enters', label: 'Enters around', kind: 'text' }),
    ],
  },
  {
    id: 'faction',
    name: 'Faction',
    lens: 'who',
    fields: [
      leader(),
      field({
        id: 'territory',
        label: 'Territory',
        kind: 'link',
        quick: true,
        multiple: true,
        reverse: 'Held by',
      }),
      home('Seat'),
      status(),
      knownFor(),
      memberOf('Part of'),
    ],
  },
  {
    id: 'family',
    name: 'Family',
    lens: 'who',
    fields: [leader('Head'), home(), status(), knownFor(), memberOf('Part of')],
  },
  {
    id: 'creature',
    name: 'Creature',
    lens: 'who',
    fields: [
      home('Habitat'),
      status(),
      knownFor(),
      field({ id: 'appearance', label: 'Appearance', kind: 'text' }),
    ],
  },
  {
    id: 'era',
    name: 'Era',
    lens: 'when',
    fields: [
      field({ id: 'era', label: 'Part of era', kind: 'link', quick: true, reverse: 'In this era' }),
      field({ id: 'outcome', label: 'Outcome', kind: 'text', quick: true }),
    ],
  },
  {
    id: 'event',
    name: 'Event',
    lens: 'when',
    fields: [
      field({ id: 'era', label: 'Era', kind: 'link', quick: true, reverse: 'In this era' }),
      field({
        id: 'where',
        label: 'Where',
        kind: 'link',
        quick: true,
        multiple: true,
        reverse: 'Happened here',
      }),
      field({
        id: 'involved',
        label: 'Who was involved',
        kind: 'link',
        quick: true,
        multiple: true,
        reverse: 'Took part in',
      }),
      field({ id: 'outcome', label: 'Outcome', kind: 'text', quick: true }),
    ],
  },
  ...(
    [
      ['magic', 'Magic'],
      ['religion', 'Religion'],
      ['law', 'Law'],
      ['technology', 'Technology'],
      ['custom', 'Custom'],
    ] as const
  ).map(([id, name]): Template => ({ id, name, lens: 'how', fields: systemFields() })),
]

/** Used for an entry whose template no longer exists: its facts are still shown. */
export const FALLBACK_TEMPLATE: Template = { id: 'note', name: 'Note', lens: 'how', fields: [] }

/** The templates in effect for a world: built-ins, replaced or joined by the world's own. */
export function worldTemplates(custom: readonly Template[]): Template[] {
  const byId = new Map(BUILT_IN_TEMPLATES.map((t) => [t.id, t]))
  for (const t of custom) byId.set(t.id, t)
  return [...byId.values()]
}

export function isBuiltIn(templateId: string): boolean {
  return BUILT_IN_TEMPLATES.some((t) => t.id === templateId)
}

/**
 * A template for an entry: its own, plus any facts it holds that the
 * template doesn't list (so changing an entry's type never hides data).
 */
export function effectiveTemplate(
  templates: readonly Template[],
  templateId: string,
  facts: Record<string, unknown[]> = {},
): Template {
  const base = templates.find((t) => t.id === templateId) ?? FALLBACK_TEMPLATE
  const known = new Set(base.fields.map((f) => f.id))
  const extra = Object.keys(facts)
    .filter((id) => !known.has(id) && facts[id]!.length > 0)
    .map((id) => {
      const elsewhere = templates.flatMap((t) => t.fields).find((f) => f.id === id)
      return elsewhere ?? field({ id, label: id, kind: 'text' })
    })
  return extra.length ? { ...base, fields: [...base.fields, ...extra] } : base
}

/** A sensible default template for a new entry in a lens. */
export const DEFAULT_TEMPLATE: Record<Lens, string> = {
  where: 'city',
  who: 'person',
  when: 'event',
  how: 'magic',
}

/** A status that means the entry has left the story. */
export const LEFT_STATUS = /\b(dead|deceased|died|killed|departed|left|gone|destroyed|fallen)\b/i
