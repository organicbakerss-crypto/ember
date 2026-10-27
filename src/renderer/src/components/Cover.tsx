import { useRef, useState, type DragEvent } from 'react'
import { coverUrl, type CoverInfo, type CoverTarget } from '@shared/media'
import { api, describeError } from '../api'

export interface CoverSource {
  /** Where the image lives (may be a fallback, e.g. the series cover for a volume). */
  target: CoverTarget
  cover: CoverInfo | null
  title: string
  subtitle?: string
  /** Picks the placeholder colour, so an item keeps its colour. */
  seed: string
}

/** A book-shaped cover: the image if there is one, otherwise a titled placeholder. */
export function Cover(props: { source: CoverSource }) {
  const { target, cover, title, subtitle, seed } = props.source
  const [broken, setBroken] = useState<string | null>(null)
  const url = cover ? coverUrl(target, cover) : null

  if (url && broken !== url) {
    return (
      <div className="cover">
        <img src={url} alt={title} draggable={false} onError={() => setBroken(url)} />
      </div>
    )
  }
  return (
    <div className="cover cover-placeholder" style={{ background: placeholderColor(seed) }}>
      <span className="cover-title">{title || 'Untitled'}</span>
      {subtitle && <span className="cover-subtitle">{subtitle}</span>}
    </div>
  )
}

const PLACEHOLDER_COLORS = 8

/** One of the theme's cover colours, chosen from the item's id. */
export function placeholderColor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `var(--cover-${hash % PLACEHOLDER_COLORS})`
}

/**
 * Wraps a cover so an image can be dropped on it or picked from a file
 * dialog. `target` is where the new image is stored.
 */
export function CoverDropZone(props: {
  target: CoverTarget
  hasCover: boolean
  children: React.ReactNode
  /** Show change/remove buttons on hover (hidden where the card itself is clickable). */
  showButtons?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      await api.invoke('cover:set', {
        target: props.target,
        data: new Uint8Array(await file.arrayBuffer()),
      })
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const remove = async () => {
    try {
      await api.invoke('cover:remove', { target: props.target })
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  return (
    <div
      className={`cover-drop ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragging(false)
        void upload(e.dataTransfer.files[0])
      }}
    >
      {props.children}
      {props.showButtons && (
        <div className="cover-actions">
          <button
            onClick={(e) => {
              e.stopPropagation()
              input.current?.click()
            }}
          >
            {props.hasCover ? 'Change cover' : 'Add cover'}
          </button>
          {props.hasCover && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void remove()
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {error && <p className="cover-error error small">{error}</p>}
    </div>
  )
}
