import { Cover, type CoverSource } from './Cover'

const MAX_VISIBLE = 3

/**
 * One cover, or several stacked like a deck of cards with the first one on
 * top. Hovering the card fans the stack out (see `.cover-stack` in the CSS).
 */
export function CoverStack(props: { sources: CoverSource[] }) {
  const visible = props.sources.slice(0, MAX_VISIBLE)
  return (
    <div className={`cover-stack ${visible.length > 1 ? 'stacked' : ''}`}>
      {visible
        .map((source, depth) => (
          <div
            key={`${source.seed}-${depth}`}
            className="cover-layer"
            style={{ '--depth': depth, zIndex: MAX_VISIBLE - depth } as React.CSSProperties}
          >
            <Cover source={source} />
          </div>
        ))
        .reverse()}
    </div>
  )
}
