import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaneRoute } from '@shared/panes'
import { PaneContext, type Pane } from './PaneContext'

/** How far the pointer must move before a press on the tab counts as a drag. */
const DRAG_START_PX = 6

/** Whether a point (in window coordinates) is outside this window. */
function outsideWindow(e: { clientX: number; clientY: number }): boolean {
  return e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight
}

/**
 * A pane: a slim tab (its name; drag it out of the window to pop it into a
 * window of its own; pop out, close, or dock back) above a view. The view
 * reports where it is through the pane context.
 *
 * Dragging uses the pointer, not the browser's drag-and-drop: while the
 * button is held the window keeps getting pointer events even outside it,
 * so letting go outside is seen everywhere (Linux included, where
 * drag-and-drop doesn't say where a drag ended).
 */
export function PaneFrame(props: {
  id: string
  title: string
  active: boolean
  split: boolean
  detached: boolean
  onActivate?: () => void
  /** The pane moved (to a chapter, an entry). */
  onRoute: (route: PaneRoute) => void
  /** Pops out (`atCursor`: dropped outside the window, so it opens there). */
  onPopOut?: (atCursor: boolean) => void
  onClose?: () => void
  onDock?: () => void
  /** A torn-off window's tab let go outside it (docks if over the main window). */
  onDropOutside?: () => void
  children: ReactNode
}) {
  const { id, active, split, detached, onRoute } = props
  const pane = useMemo<Pane>(
    () => ({ id, active, split, detached, onRoute }),
    [id, active, split, detached, onRoute],
  )
  const start = useRef<{ x: number; y: number; pointer: number } | null>(null)
  const [drag, setDrag] = useState<'inside' | 'outside' | null>(null)
  const canTear = detached ? !!props.onDropOutside : !!props.onPopOut

  return (
    <section
      className={`pane ${active && split ? 'active' : ''} ${drag ? `tearing ${drag}` : ''}`}
      aria-label={props.title}
      onPointerDownCapture={props.onActivate}
      onFocusCapture={props.onActivate}
    >
      <div
        className="pane-tab small"
        title={
          canTear
            ? detached
              ? 'Drag onto the main window to dock'
              : 'Drag out of the window to pop out'
            : undefined
        }
        onPointerDown={(e) => {
          if (!canTear || e.button !== 0 || (e.target as Element).closest('button')) return
          start.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (!s) return
          if (!drag && Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_START_PX) return
          setDrag(outsideWindow(e) ? 'outside' : 'inside')
        }}
        onPointerUp={(e) => {
          const s = start.current
          start.current = null
          setDrag(null)
          if (!s || !drag || !outsideWindow(e)) return
          if (detached) props.onDropOutside?.()
          else props.onPopOut?.(true)
        }}
        onPointerCancel={() => {
          start.current = null
          setDrag(null)
        }}
      >
        <span className="pane-grip" aria-hidden>
          ⠿
        </span>
        <span className="pane-title">{props.title}</span>
        <span className="status-spacer" />
        {props.onDock && (
          <button className="link" onClick={props.onDock} title="Put this back in the main window">
            Dock
          </button>
        )}
        {props.onPopOut && (
          <button
            className="icon"
            aria-label="Pop out"
            title="Pop out into its own window"
            onClick={() => props.onPopOut?.(false)}
          >
            ⧉
          </button>
        )}
        {props.onClose && (
          <button className="icon" aria-label="Close pane" title="Close" onClick={props.onClose}>
            ✕
          </button>
        )}
      </div>
      <div className="pane-body">
        <PaneContext.Provider value={pane}>{props.children}</PaneContext.Provider>
        {drag && (
          <div className="pane-drop-hint" role="status">
            {drag === 'outside'
              ? detached
                ? 'Let go over the main window to dock'
                : 'Let go to open it in its own window'
              : detached
                ? 'Drag onto the main window to dock'
                : 'Drag out of the window to open it in its own window'}
          </div>
        )}
      </div>
    </section>
  )
}
