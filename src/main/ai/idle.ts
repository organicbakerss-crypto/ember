/**
 * A time limit that only counts silence: a request is given up when nothing
 * has arrived for `ms` (a long answer that keeps streaming is fine). Also
 * follows the caller's own Stop.
 */
export interface IdleLimit {
  signal: AbortSignal
  reset(): void
  readonly timedOut: boolean
  done(): void
}

export function idleLimit(outer: AbortSignal | undefined, ms: number): IdleLimit {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const stop = () => controller.abort()
  if (outer?.aborted) controller.abort()
  outer?.addEventListener('abort', stop)
  reset()
  return {
    signal: controller.signal,
    /** Something arrived: start counting again. */
    reset,
    get timedOut() {
      return timedOut
    },
    done() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', stop)
    },
  }
}
