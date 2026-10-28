import type { Portrait as PortraitData } from '@shared/schema'
import { worldImageUrl } from '@shared/media'
import { initials } from './model'

/** An entry's portrait (cropped to a square), or its initials. */
export function Portrait(props: {
  worldId: string
  name: string
  portrait: PortraitData | null
  size?: 'small' | 'medium' | 'large'
}) {
  const { portrait } = props
  const className = `portrait portrait-${props.size ?? 'medium'}`
  if (!portrait) {
    return (
      <span className={`${className} portrait-empty`} aria-hidden>
        {initials(props.name)}
      </span>
    )
  }
  const { x, y, size } = portrait.crop
  return (
    <span className={className}>
      <img
        src={worldImageUrl(props.worldId, portrait.file)}
        alt={`Portrait of ${props.name}`}
        draggable={false}
        style={{
          objectPosition: `${x * 100}% ${y * 100}%`,
          transformOrigin: `${x * 100}% ${y * 100}%`,
          transform: `scale(${1 / size})`,
        }}
      />
    </span>
  )
}
