import { familyTree } from '@shared/world/relationships'
import { worldImageUrl } from '@shared/media'
import { initials } from '../model'
import type { WorldData } from '../useWorld'

const COL = 170
const ROW = 150
const R = 30
/** Below the portrait and its name, where a line to the children starts. */
const LABEL = R + 30

/** Family links laid out as a tree: parents above children, partners side by side. */
export function FamilyTreeView(props: {
  world: WorldData
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  const tree = familyTree(world.view.relationships)
  if (!tree.nodes.length) {
    return (
      <p className="muted">
        No family links yet. On the board, drag one person onto another, choose Family, and say
        whether one is the other’s parent, or they’re siblings or partners.
      </p>
    )
  }
  const rows = new Map<number, number>()
  for (const n of tree.nodes)
    rows.set(n.generation, Math.max(rows.get(n.generation) ?? 0, n.column + 1))
  const widest = Math.max(...rows.values())
  const at = new Map(
    tree.nodes.map((n) => {
      // Centre each generation's row under the widest one.
      const offset = ((widest - rows.get(n.generation)!) * COL) / 2
      return [n.id, { x: offset + n.column * COL + COL / 2, y: n.generation * ROW + ROW / 2 }]
    }),
  )
  const parentsOf = new Map(tree.children.map((c) => [c.child, c.parents]))
  const shareParent = (a: string, b: string) =>
    (parentsOf.get(a) ?? []).some((p) => parentsOf.get(b)?.includes(p))
  const width = widest * COL
  const height = (Math.max(...rows.keys()) + 1) * ROW
  return (
    <div className="family-tree board-scroll">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: Math.min(width, 1400), maxWidth: '100%' }}
        role="img"
        aria-label="Family tree"
      >
        <defs>
          <clipPath id="tree-portrait" clipPathUnits="objectBoundingBox">
            <circle cx="0.5" cy="0.5" r="0.5" />
          </clipPath>
        </defs>
        {tree.partners.map(([a, b]) => {
          const p = at.get(a)!
          const q = at.get(b)!
          return (
            <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="tree-partners" />
          )
        })}
        {tree.children.map(({ child, parents }) => {
          const c = at.get(child)!
          const ps = parents.map((p) => at.get(p)!).filter(Boolean)
          if (!ps.length) return null
          const px = ps.reduce((s, p) => s + p.x, 0) / ps.length
          const py = ps[0]!.y
          const mid = (py + c.y) / 2
          return (
            <path
              key={child}
              className="tree-child"
              d={`M${px},${py + (ps.length > 1 ? 0 : LABEL)} V${mid} H${c.x} V${c.y - R}`}
            />
          )
        })}
        {tree.siblings
          .filter(([a, b]) => !shareParent(a, b))
          .map(([a, b]) => {
            const p = at.get(a)!
            const q = at.get(b)!
            const top = Math.min(p.y, q.y) - R - 16
            return (
              <path
                key={`${a}-${b}`}
                className="tree-siblings"
                d={`M${p.x},${p.y - R} V${top} H${q.x} V${q.y - R}`}
              />
            )
          })}
        {tree.nodes.map((n) => {
          const e = world.resolve(n.id)
          const { x, y } = at.get(n.id)!
          return (
            <g
              key={n.id}
              className="board-person"
              transform={`translate(${x} ${y})`}
              role="button"
              aria-label={e?.name ?? 'Missing'}
              onClick={() => props.onOpenEntry(n.id)}
            >
              <circle r={R} className="board-portrait-ring" />
              {e?.portrait ? (
                <image
                  href={worldImageUrl(world.view.world.id, e.portrait.file)}
                  x={-R + 3}
                  y={-R + 3}
                  width={(R - 3) * 2}
                  height={(R - 3) * 2}
                  clipPath="url(#tree-portrait)"
                  preserveAspectRatio="xMidYMid slice"
                />
              ) : (
                <text y={7} textAnchor="middle" className="board-initials">
                  {initials(e?.name ?? '?')}
                </text>
              )}
              <text y={R + 20} textAnchor="middle" className="board-name">
                {e?.name ?? '(missing)'}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
