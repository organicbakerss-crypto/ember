import { useRef, useState, type ReactNode } from 'react'
import { loadLocal, saveLocal } from '../storage'
import { PANE_DRAG } from './PaneFrame'

const KEY = 'layout.split'
const MIN = 0.25
const MAX = 0.75
const DEFAULT = 0.55

const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n))

/**
 * Two panes side by side with a divider to drag. The split size is
 * remembered on this device (never synced).
 */
export function SplitView(props: { left: ReactNode; right: ReactNode }) {
  const [size, setSize] = useState(() => {
    const saved = Number(loadLocal(KEY))
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : DEFAULT
  })
  const box = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const move = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect()
    if (rect && rect.width > 0) setSize(clamp((clientX - rect.left) / rect.width))
  }

  return (
    <div
      ref={box}
      className={`split-view ${dragging ? 'resizing' : ''}`}
      style={{ gridTemplateColumns: `${size}fr 6px ${1 - size}fr` }}
      // A torn-off pane's tab dropped here docks it (its window sees the drop and docks).
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG)) e.preventDefault()
      }}
    >
      {props.left}
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuenow={Math.round(size * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => dragging && move(e.clientX)}
        onPointerUp={() => {
          setDragging(false)
          saveLocal(KEY, String(size))
        }}
        onDoubleClick={() => {
          setSize(DEFAULT)
          saveLocal(KEY, String(DEFAULT))
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? -0.03 : e.key === 'ArrowRight' ? 0.03 : 0
          if (!step) return
          e.preventDefault()
          const next = clamp(size + step)
          setSize(next)
          saveLocal(KEY, String(next))
        }}
      />
      {props.right}
    </div>
  )
}
