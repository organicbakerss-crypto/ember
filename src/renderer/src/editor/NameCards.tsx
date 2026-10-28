import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { EntrySummary } from '@shared/ipc'
import type { NameTerm } from '@shared/names'
import { MOD } from '../components/commands'
import type { LinkHover } from './linkedNames'

export interface NameIndex {
  entries: Map<string, EntrySummary>
  categories: Map<string, string>
  terms: NameTerm[]
}

const SHOW_DELAY_MS = 350
const HIDE_DELAY_MS = 250

/**
 * Connects an editor's linked names to the world: keeps its names up to date
 * and shows a small card when a name is hovered.
 */
export function NameCards(props: {
  editor: Editor
  index: NameIndex | null
  enabled: boolean
  onOpen: (entryId: string) => void
}) {
  const { editor, index, enabled, onOpen } = props
  const [hover, setHover] = useState<LinkHover | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openRef = useRef(onOpen)
  useEffect(() => {
    openRef.current = onOpen
  })

  useEffect(() => {
    editor.commands.setLinkedNames(index?.terms ?? [], enabled && !!index)
  }, [editor, index, enabled])

  useEffect(() => {
    editor.commands.onLinkedNames({
      onHover: (h) => {
        clearTimeout(showTimer.current)
        clearTimeout(hideTimer.current)
        if (h) showTimer.current = setTimeout(() => setHover(h), SHOW_DELAY_MS)
        else hideTimer.current = setTimeout(() => setHover(null), HIDE_DELAY_MS)
      },
      onOpen: (id) => {
        setHover(null)
        openRef.current(id)
      },
    })
    return () => {
      clearTimeout(showTimer.current)
      clearTimeout(hideTimer.current)
      if (!editor.isDestroyed) editor.commands.onLinkedNames({ onHover: null, onOpen: null })
    }
  }, [editor])

  const entry = hover && index?.entries.get(hover.entryId)
  if (!hover || !entry) return null
  const category = entry.categoryId ? index?.categories.get(entry.categoryId) : null
  const top = Math.min(hover.rect.bottom + 6, window.innerHeight - 180)
  const left = Math.min(hover.rect.left, window.innerWidth - 320)

  return (
    <div
      className="name-card"
      role="tooltip"
      style={{ top, left }}
      onMouseEnter={() => clearTimeout(hideTimer.current)}
      onMouseLeave={() => setHover(null)}
    >
      <div className="name-card-head">
        <strong>{entry.name}</strong>
        {category && <span className="muted small">{category}</span>}
      </div>
      {entry.aliases.length > 0 && (
        <div className="muted small">Also: {entry.aliases.join(', ')}</div>
      )}
      {entry.snippet ? (
        <p className="small">{entry.snippet}</p>
      ) : (
        <p className="muted small">Nothing written yet.</p>
      )}
      <div className="name-card-foot">
        <button
          className="link small"
          onClick={() => {
            setHover(null)
            onOpen(entry.id)
          }}
        >
          Open in World
        </button>
        <span className="muted small">or {MOD}click the name</span>
      </div>
    </div>
  )
}
