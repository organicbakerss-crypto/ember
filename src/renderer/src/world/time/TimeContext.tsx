import { createContext, useContext } from 'react'
import type { TimelineStop } from '@shared/world/timeline'

export interface TimeState {
  /** The scrubber's stop; null for now (the latest chapter). */
  stop: TimelineStop | null
  setStop: (stop: TimelineStop | null) => void
  /** Whether the scrubber is shown at all (Settings → World). */
  enabled: boolean
}

export const TimeContext = createContext<TimeState>({
  stop: null,
  setStop: () => {},
  enabled: false,
})

/** The moment World mode is showing, and a way to change it. */
export function useTime(): TimeState {
  return useContext(TimeContext)
}
