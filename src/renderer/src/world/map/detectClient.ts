/**
 * Talks to the detection worker. One worker for the window, started on first
 * use. A step that fails or takes too long is reported, never left hanging:
 * the worker is restarted and the caller gets an error to show.
 */
import type { Point } from '@shared/schema'
import type { Method, Pixels, Rings } from './detect'

export type DetectRequest =
  | { op: 'load'; key: string; pixels: Pixels }
  | { op: 'detect'; key: string; method: Method | 'auto'; seaPoint?: Point }
  | {
      op: 'wand'
      key: string
      point: Point
      tolerance: number
      base?: { rings: Rings; mode: 'add' | 'subtract' }
    }
  | { op: 'merge'; key: string; regions: Rings[] }
  | { op: 'split'; key: string; rings: Rings; line: Point[] }

/** The first step also loads OpenCV and smooths the image, so it gets longer. */
const TIMEOUT_MS = 90_000

let worker: Worker | null = null
let nextId = 1
let loadedKey: string | null = null
const waiting = new Map<
  number,
  {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

/** Stops the worker and fails everything waiting on it; the next call starts a fresh one. */
function reset(message: string) {
  worker?.terminate()
  worker = null
  loadedKey = null
  for (const [id, pending] of waiting) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
    waiting.delete(id)
  }
}

function start(): Worker {
  const w = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const pending = waiting.get(e.data.id)
    if (!pending) return
    waiting.delete(e.data.id)
    clearTimeout(pending.timer)
    if (e.data.error) pending.reject(new Error(e.data.error))
    else pending.resolve(e.data.result)
  }
  w.onerror = (e) => {
    e.preventDefault()
    reset(
      `Region detection couldn’t start (${e.message || 'unknown error'}). If the app was just updated, run “npm install” and restart it.`,
    )
  }
  return w
}

function call<T>(request: DetectRequest): Promise<T> {
  worker ??= start()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reset(
          'Region detection took too long and was stopped. Try a smaller image, or the magic wand.',
        ),
      TIMEOUT_MS,
    )
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    worker!.postMessage({ ...request, id })
  })
}

export const detector = {
  async load(key: string, pixels: Pixels): Promise<void> {
    if (loadedKey === key && worker) return
    await call({ op: 'load', key, pixels })
    loadedKey = key
  },
  detect: (key: string, method: Method | 'auto', seaPoint?: Point) =>
    call<{ method: Method; regions: Rings[] }>({ op: 'detect', key, method, seaPoint }),
  wand: (
    key: string,
    point: Point,
    tolerance: number,
    base?: { rings: Rings; mode: 'add' | 'subtract' },
  ) => call<Rings | null>({ op: 'wand', key, point, tolerance, base }),
  merge: (key: string, regions: Rings[]) => call<Rings | null>({ op: 'merge', key, regions }),
  split: (key: string, rings: Rings, line: Point[]) =>
    call<Rings[] | null>({ op: 'split', key, rings, line }),
}
