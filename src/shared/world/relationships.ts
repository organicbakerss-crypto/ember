/**
 * The people board's logic, free of any view: which relationships hold at a
 * moment, how the lines between two people look (colours that blend along
 * the line, never averaged; dashed when over), the words for a line, and the
 * family tree layout.
 */
import type { RelationshipFile, RelationshipType } from '../schema'
import type { ChapterPositions, Moment } from './facts'

export const BUILT_IN_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  { id: 'met', label: 'Met', colour: '#8a8a8a' },
  { id: 'friends', label: 'Friends / allies', colour: '#3f9a5a' },
  { id: 'enemies', label: 'Fought / enemies', colour: '#d0453a' },
  { id: 'family', label: 'Family', colour: '#3b78d8' },
  { id: 'romance', label: 'Romance', colour: '#e05f9a' },
  { id: 'mentor', label: 'Mentor / loyal to', colour: '#d4a017' },
  { id: 'rivals', label: 'Rivals', colour: '#8b5cc6' },
]

/** Strongest first: when lines don't blend, a line takes the strongest type's colour. */
const STRENGTH = ['family', 'romance', 'enemies', 'rivals', 'mentor', 'friends', 'met']

export function relationshipTypes(custom: readonly RelationshipType[]): RelationshipType[] {
  const byId = new Map(BUILT_IN_RELATIONSHIP_TYPES.map((t) => [t.id, t]))
  for (const t of custom) byId.set(t.id, t)
  return [...byId.values()]
}

function startOf(rel: RelationshipFile, positions: ChapterPositions): number {
  return rel.start?.kind === 'chapter' ? (positions.get(rel.start.chapterId) ?? -1) : -1
}

/** Whether a relationship has started by a moment, and whether it is over then. */
export function relationshipAt(
  rel: RelationshipFile,
  at: Moment,
  positions: ChapterPositions,
): { over: boolean } | null {
  const reached = (anchor: RelationshipFile['start']) => {
    if (!anchor) return true
    if (at === null || anchor.kind !== 'chapter') return true
    const p = positions.get(anchor.chapterId)
    return p === undefined || p <= at
  }
  if (rel.start && !reached(rel.start)) return null
  return { over: rel.over || (!!rel.end && reached(rel.end)) }
}

export interface BoardLine {
  /** The two entries, in a fixed order (a, b sorted by id). */
  a: string
  b: string
  relationships: RelationshipFile[]
  /** Colours along the line, in time order (one per type). */
  colours: string[]
  /** Every relationship on it is over. */
  over: boolean
}

/**
 * One line per pair of entries, from the relationships that hold at a
 * moment. "Met" only shows when nothing else does. Hidden types are left
 * out. Without blending, a line has only its strongest type's colour.
 */
export function boardLines(
  rels: readonly RelationshipFile[],
  types: readonly RelationshipType[],
  options: {
    at: Moment
    positions: ChapterPositions
    hidden?: ReadonlySet<string>
    blend?: boolean
  },
): BoardLine[] {
  const colour = new Map(types.map((t) => [t.id, t.colour]))
  const groups = new Map<
    string,
    { a: string; b: string; rels: { rel: RelationshipFile; over: boolean }[] }
  >()
  for (const rel of rels) {
    if (rel.from === rel.to || options.hidden?.has(rel.type)) continue
    const state = relationshipAt(rel, options.at, options.positions)
    if (!state) continue
    const [a, b] = rel.from < rel.to ? [rel.from, rel.to] : [rel.to, rel.from]
    const key = `${a}|${b}`
    const g = groups.get(key) ?? { a, b, rels: [] }
    g.rels.push({ rel, over: state.over })
    groups.set(key, g)
  }
  const out: BoardLine[] = []
  for (const g of groups.values()) {
    const real = g.rels.filter((r) => r.rel.type !== 'met')
    const shown = real.length ? real : g.rels
    const inTime = [...shown].sort(
      (x, y) => startOf(x.rel, options.positions) - startOf(y.rel, options.positions),
    )
    let typeIds = [...new Set(inTime.map((r) => r.rel.type))]
    if (options.blend === false) {
      typeIds = [[...typeIds].sort((x, y) => rank(x) - rank(y))[0]!]
    }
    out.push({
      a: g.a,
      b: g.b,
      relationships: inTime.map((r) => r.rel),
      colours: typeIds.map((id) => colour.get(id) ?? '#8a8a8a'),
      over: inTime.every((r) => r.over),
    })
  }
  return out
}

function rank(typeId: string): number {
  const i = STRENGTH.indexOf(typeId)
  return i === -1 ? STRENGTH.length - 1.5 : i
}

/**
 * Gradient stops for a line with several colours: each colour holds for the
 * middle of its band and fades into the next. Colours are never averaged.
 */
export function bandStops(colours: readonly string[]): { offset: number; colour: string }[] {
  if (colours.length <= 1) return colours.map((colour) => ({ offset: 0, colour }))
  const n = colours.length
  const fade = 0.15 / n
  return colours.flatMap((colour, i) => {
    const from = i / n
    const to = (i + 1) / n
    return [
      { offset: i === 0 ? 0 : from + fade, colour },
      { offset: i === n - 1 ? 1 : to - fade, colour },
    ]
  })
}

/** The words for a line: "Rivals, then romance"; types that start together join with "and". */
export function describeLine(
  line: Pick<BoardLine, 'relationships'>,
  types: readonly RelationshipType[],
  positions: ChapterPositions,
): string {
  const label = (rel: RelationshipFile) =>
    rel.label || (types.find((t) => t.id === rel.type)?.label ?? rel.type)
  const parts: string[] = []
  let last: number | null = null
  for (const rel of line.relationships) {
    const words = label(rel).toLowerCase()
    const s = startOf(rel, positions)
    const over = rel.over || rel.end ? ' (over)' : ''
    if (!parts.length) parts.push(words + over)
    else parts.push(`${s === last ? ' and ' : ', then '}${words}${over}`)
    last = s
  }
  const text = parts.join('')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/* ---------- the family tree ---------- */

export interface FamilyTree {
  /** People in the tree, with their generation (row) and place in it (column). */
  nodes: { id: string; generation: number; column: number }[]
  partners: [string, string][]
  /** Siblings, to be joined by a bracket when no shared parent already joins them. */
  siblings: [string, string][]
  /** Each child with its parents (one or two). */
  children: { child: string; parents: string[] }[]
}

/**
 * Lays family links out as a tree: parents a row above their children,
 * partners and siblings side by side. Columns are ordered so children sit
 * under their parents where possible.
 */
export function familyTree(rels: readonly RelationshipFile[]): FamilyTree {
  const family = rels.filter((r) => r.type === 'family' && r.kin && r.from !== r.to)
  const parentsOf = new Map<string, Set<string>>()
  const partners: [string, string][] = []
  const siblings: [string, string][] = []
  const people = new Set<string>()
  for (const r of family) {
    people.add(r.from)
    people.add(r.to)
    if (r.kin === 'parent') parentsOf.set(r.to, (parentsOf.get(r.to) ?? new Set()).add(r.from))
    else if (r.kin === 'partner') partners.push([r.from, r.to])
    else siblings.push([r.from, r.to])
  }
  // Generations: children below parents; partners and siblings level with each other.
  const gen = new Map([...people].map((p) => [p, 0]))
  for (let pass = 0; pass < people.size + 2; pass++) {
    let changed = false
    const raise = (id: string, to: number) => {
      if ((gen.get(id) ?? 0) < to) {
        gen.set(id, to)
        changed = true
      }
    }
    for (const [child, parents] of parentsOf) {
      for (const p of parents) raise(child, (gen.get(p) ?? 0) + 1)
    }
    for (const [a, b] of [...partners, ...siblings]) {
      const g = Math.max(gen.get(a)!, gen.get(b)!)
      raise(a, g)
      raise(b, g)
    }
    if (!changed) break
  }
  // Columns: by first appearance, then pulled under parents, keeping partners together.
  const rows = new Map<number, string[]>()
  for (const id of people) {
    const g = gen.get(id)!
    rows.set(g, [...(rows.get(g) ?? []), id])
  }
  const column = new Map<string, number>()
  const generations = [...rows.keys()].sort((a, b) => a - b)
  for (const g of generations) {
    let row = rows.get(g)!
    if (g > generations[0]!) {
      const centre = (id: string) => {
        const ps = [...(parentsOf.get(id) ?? [])].filter((p) => column.has(p))
        return ps.length ? ps.reduce((s, p) => s + column.get(p)!, 0) / ps.length : Infinity
      }
      row = [...row].sort((a, b) => centre(a) - centre(b))
    }
    // Partners, then siblings, next to each other.
    const ordered: string[] = []
    for (const id of row) {
      if (ordered.includes(id)) continue
      ordered.push(id)
      for (const [a, b] of [...partners, ...siblings]) {
        const other = a === id ? b : b === id ? a : null
        if (other && row.includes(other) && !ordered.includes(other)) ordered.push(other)
      }
    }
    ordered.forEach((id, i) => column.set(id, i))
  }
  return {
    nodes: [...people].map((id) => ({ id, generation: gen.get(id)!, column: column.get(id)! })),
    partners,
    siblings,
    children: [...parentsOf].map(([child, parents]) => ({ child, parents: [...parents] })),
  }
}

/** A relationship in words for the text forms: "Mara — sister of → Odo (family, from Ch 3)". */
export function relationshipText(
  rel: RelationshipFile,
  names: ReadonlyMap<string, string>,
  types: readonly RelationshipType[],
  chapterLabel: (chapterId: string) => string | undefined,
): string {
  const type = types.find((t) => t.id === rel.type)?.label ?? rel.type
  const when = (prefix: string, anchor: RelationshipFile['start']) =>
    !anchor
      ? null
      : anchor.kind === 'chapter'
        ? `${prefix} ${chapterLabel(anchor.chapterId) ?? 'a chapter'}`
        : `${prefix} ${names.get(anchor.entryId) ?? 'an event'}`
  const notes = [
    type.toLowerCase(),
    rel.kin && rel.kin !== 'sibling'
      ? rel.kin === 'parent'
        ? 'parent of'
        : 'partners'
      : rel.kin === 'sibling'
        ? 'siblings'
        : null,
    when('from', rel.start),
    when('until', rel.end),
    rel.over && !rel.end ? 'over' : null,
  ].filter(Boolean)
  const from = `${names.get(rel.from) ?? '(missing)'} [${rel.from}]`
  const to = `${names.get(rel.to) ?? '(missing)'} [${rel.to}]`
  return `${from} — ${rel.label || type.toLowerCase()} → ${to} (${notes.join(', ')})`
}
