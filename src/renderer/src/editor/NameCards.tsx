import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { NameTerm } from '@shared/names'
import type { Moment } from '@shared/world/facts'
import { MOD } from '../components/commands'
import { EntryCard } from '../world/EntryCard'
import type { WorldData } from '../world/useWorld'
import type { LinkHover } from './linkedNames'

export interface NameIndex {
  world: WorldData
  terms: NameTerm[]
  /** Facts in cards are shown as of this moment (the chapter being written). */
  at?: Moment
}

const SHOW_DELAY_MS = 350
const HIDE_DELAY_MS = 250

/**
 * Connects an editor's linked names to the world: keeps its names up to date
 * and shows the entry's card when a name is hovered.
 */
export function NameCards(props: {
  editor: Editor
  index: NameIndex | null
  enabled: boolean
  /** Cards on hover (otherwise names only open on Ctrl/Cmd+click). */
  hoverCards?: boolean
  onOpen: (entryId: string) => void
}) {
  const { editor, index, enabled, onOpen } = props
  const [hover, setHover] = useState<LinkHover | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openRef = useRef(onOpen)
  const cardsRef = useRef(props.hoverCards ?? true)
  useEffect(() => {
    openRef.current = onOpen
    cardsRef.current = props.hoverCards ?? true
  })

  useEffect(() => {
    editor.commands.setLinkedNames(index?.terms ?? [], enabled && !!index)
  }, [editor, index, enabled])

  useEffect(() => {
    editor.commands.onLinkedNames({
      onHover: (h) => {
        clearTimeout(showTimer.current)
        clearTimeout(hideTimer.current)
        if (h && cardsRef.current) showTimer.current = setTimeout(() => setHover(h), SHOW_DELAY_MS)
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

  const entry = hover && index?.world.resolve(hover.entryId)
  if (!hover || !entry || !index) return null
  const top = Math.min(hover.rect.bottom + 6, window.innerHeight - 240)
  const left = Math.min(hover.rect.left, window.innerWidth - 320)
  const open = (id: string) => {
    setHover(null)
    onOpen(id)
  }

  return (
    <div
      className="name-card"
      role="tooltip"
      style={{ top, left }}
      onMouseEnter={() => clearTimeout(hideTimer.current)}
      onMouseLeave={() => setHover(null)}
    >
      <EntryCard world={index.world} entry={entry} at={index.at ?? null} onOpenEntry={open} />
      <div className="name-card-foot">
        <button className="link small" onClick={() => open(entry.id)}>
          Open page
        </button>
        <span className="muted small">or {MOD}click the name</span>
      </div>
    </div>
  )
}
