import { useMemo, useRef, type ReactNode } from 'react'
import type { PaneRoute } from '@shared/panes'
import { PaneContext, type Pane } from './PaneContext'

/** The drag type of a pane's tab (dropped on another window, it docks there). */
export const PANE_DRAG = 'application/x-pane'

/** Whether a drag ended outside this window (screen coordinates). */
function outsideWindow(e: { screenX: number; screenY: number }): boolean {
  return (
    e.screenX < window.screenX ||
    e.screenY < window.screenY ||
    e.screenX > window.screenX + window.outerWidth ||
    e.screenY > window.screenY + window.outerHeight
  )
}

/**
 * A pane: a slim tab (its name; drag it out of the window to pop it into a
 * window of its own; pop out, close, or dock back) above a view. The view
 * reports where it is through the pane context.
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
  onPopOut?: () => void
  onClose?: () => void
  onDock?: () => void
  children: ReactNode
}) {
  const { id, active, split, detached, onRoute } = props
  const pane = useMemo<Pane>(
    () => ({ id, active, split, detached, onRoute }),
    [id, active, split, detached, onRoute],
  )
  const dragging = useRef(false)
  return (
    <section
      className={`pane ${active && split ? 'active' : ''}`}
      aria-label={props.title}
      onPointerDownCapture={props.onActivate}
      onFocusCapture={props.onActivate}
    >
      <div
        className="pane-tab small"
        draggable
        title={detached ? 'Drag onto the main window to dock' : 'Drag out of the window to pop out'}
        onDragStart={(e) => {
          dragging.current = true
          e.dataTransfer.setData(PANE_DRAG, id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={(e) => {
          if (!dragging.current) return
          dragging.current = false
          // Dropped outside the window: a window of its own. A torn-off pane
          // dropped on the main window docks there.
          if (!detached && e.dataTransfer.dropEffect === 'none' && outsideWindow(e))
            props.onPopOut?.()
          if (detached && e.dataTransfer.dropEffect === 'move' && outsideWindow(e)) props.onDock?.()
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
            onClick={props.onPopOut}
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
      </div>
    </section>
  )
}
