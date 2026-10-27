import { useEffect, useRef } from 'react'
import type { IpcEvents } from '@shared/ipc'

export const api = window.api

/** Splits the "[code] message" errors produced by the preload. */
export function describeError(err: unknown): { code: string; message: string } {
  const text = err instanceof Error ? err.message : String(err)
  const match = /\[([a-z-]+)\] (.*)$/s.exec(text)
  return match ? { code: match[1]!, message: match[2]! } : { code: 'internal', message: text }
}

/** Subscribes to a main-process broadcast for the lifetime of a component. */
export function useIpcEvent<E extends keyof IpcEvents>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
): void {
  const ref = useRef(listener)
  useEffect(() => {
    ref.current = listener
  })
  useEffect(() => api.on(event, (payload) => ref.current(payload)), [event])
}
