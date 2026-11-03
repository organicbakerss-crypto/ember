import { createContext, useContext } from 'react'
import type { PaneRoute } from '@shared/panes'

export interface Pane {
  /** Unique in the window (with the window, it names a place that can edit a document). */
  id: string
  /** The pane the writer is working in: only it answers keyboard shortcuts. */
  active: boolean
  /** Shown beside another pane (split screen). */
  split: boolean
  /** This window is a torn-off pane of its own. */
  detached: boolean
  /** Report where the pane is now (a torn-off window reopens there). */
  onRoute?: (route: PaneRoute) => void
}

export const PaneContext = createContext<Pane>({
  id: 'main',
  active: true,
  split: false,
  detached: false,
})

/** The pane this view is in. */
export function usePane(): Pane {
  return useContext(PaneContext)
}
