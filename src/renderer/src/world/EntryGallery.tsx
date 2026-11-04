import { useEffect, useRef, useState } from 'react'
import { worldImageUrl } from '@shared/media'
import type { Picture, WorldEntryFile } from '@shared/schema'
import { api, describeError } from '../api'

/**
 * An entry's pictures besides its portrait (outfits, house plans, reference
 * art): add by choosing files or dropping them here, caption them, open one
 * larger, make one the portrait, or take one off.
 */
export function EntryGallery(props: {
  worldId: string
  entry: WorldEntryFile
  /** The entry after a picture was added (already saved). */
  onAdded: (entry: WorldEntryFile, file: string) => void
  onChange: (gallery: Picture[], label: string) => void
  onMakePortrait: (file: string) => void
  onError: (message: string) => void
}) {
  const { entry, worldId } = props
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const add = async (files: FileList | File[]) => {
    for (const file of [...files].filter((f) => f.type.startsWith('image/'))) {
      try {
        const saved = await api.invoke('entry:addPicture', {
          worldId,
          entryId: entry.id,
          data: new Uint8Array(await file.arrayBuffer()),
        })
        props.onAdded(saved, saved.gallery[saved.gallery.length - 1]?.file ?? '')
      } catch (err) {
        props.onError(describeError(err).message)
      }
    }
  }

  const pictures = entry.gallery
  const shown = open === null ? undefined : pictures[open]
  return (
    <section
      className={`entry-section entry-gallery ${dragOver ? 'drag-over' : ''}`}
      aria-label="Pictures"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void add(e.dataTransfer.files)
      }}
    >
      <h3>
        Pictures
        <button className="link small" onClick={() => input.current?.click()}>
          + add
        </button>
      </h3>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void add(e.target.files)
          e.target.value = ''
        }}
      />
      {pictures.length === 0 ? (
        <p className="muted small">
          Outfits, maps of a house, reference art: drop pictures here, or click + add.
        </p>
      ) : (
        <ul className="gallery-grid">
          {pictures.map((p, i) => (
            <li key={p.file}>
              <button className="gallery-thumb" onClick={() => setOpen(i)} title="Open larger">
                <img src={worldImageUrl(worldId, p.file)} alt={p.caption || entry.name} />
              </button>
              <Caption
                value={p.caption}
                onSave={(caption) =>
                  props.onChange(
                    pictures.map((x, j) => (j === i ? { ...x, caption } : x)),
                    `Captioned a picture of ${entry.name}`,
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
      {open !== null && shown && (
        <Lightbox
          src={worldImageUrl(worldId, shown.file)}
          caption={shown.caption}
          position={`${open + 1} of ${pictures.length}`}
          onClose={() => setOpen(null)}
          onStep={(d) => setOpen((open + d + pictures.length) % pictures.length)}
          onMakePortrait={() => {
            props.onMakePortrait(shown.file)
            setOpen(null)
          }}
          onRemove={() => {
            props.onChange(
              pictures.filter((_, j) => j !== open),
              `Took a picture off ${entry.name}`,
            )
            setOpen(null)
          }}
        />
      )}
    </section>
  )
}

function Caption(props: { value: string; onSave: (caption: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className="gallery-caption small"
      aria-label="Caption"
      placeholder="Caption"
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== props.value) props.onSave(draft.slice(0, 500))
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

function Lightbox(props: {
  src: string
  caption: string
  position: string
  onClose: () => void
  onStep: (delta: number) => void
  onMakePortrait: () => void
  onRemove: () => void
}) {
  const { onClose, onStep } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') onStep(1)
      else if (e.key === 'ArrowLeft') onStep(-1)
      else return
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onStep])
  return (
    <div className="lightbox" role="dialog" aria-label="Picture" onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={props.src} alt={props.caption} />
        <figcaption className="small">
          <span>{props.caption}</span>
          <span className="muted">{props.position}</span>
          <span className="status-spacer" />
          <button className="small" onClick={() => props.onStep(-1)} aria-label="Previous">
            ←
          </button>
          <button className="small" onClick={() => props.onStep(1)} aria-label="Next">
            →
          </button>
          <button className="small" onClick={props.onMakePortrait}>
            Use as portrait
          </button>
          <button className="small" onClick={props.onRemove}>
            Take it off
          </button>
          <button className="small" onClick={props.onClose}>
            Close
          </button>
        </figcaption>
      </figure>
    </div>
  )
}
