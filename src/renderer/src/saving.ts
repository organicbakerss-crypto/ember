/**
 * Everything with unsaved work registers a flush function here, so the
 * window can save it all before it closes.
 */
const flushers = new Set<() => Promise<void>>()

export function registerFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush)
  return () => flushers.delete(flush)
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([...flushers].map((flush) => flush()))
}
