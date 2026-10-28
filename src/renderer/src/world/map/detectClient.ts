/** Talks to the detection worker. One worker for the window, started on first use. */
import type { Point } from '@shared/schema'
import type { Pixels, Rings } from './detect'

export type DetectRequest =
  | { op: 'load'; key: string; pixels: Pixels }
  | { op: 'detectAll'; key: string }
  | { op: 'wand'; key: string; point: Point; tolerance: number }
  | { op: 'merge'; key: string; regions: Rings[] }
  | { op: 'split'; key: string; rings: Rings; line: Point[] }

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function call<T>(request: DetectRequest): Promise<T> {
  worker ??= (() => {
    const w = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const pending = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      if (e.data.error) pending?.reject(new Error(e.data.error))
      else pending?.resolve(e.data.result)
    }
    return w
  })()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ ...request, id })
  })
}

let loadedKey: string | null = null

export const detector = {
  async load(key: string, pixels: Pixels): Promise<void> {
    if (loadedKey === key) return
    await call({ op: 'load', key, pixels })
    loadedKey = key
  },
  detectAll: (key: string) => call<Rings[]>({ op: 'detectAll', key }),
  wand: (key: string, point: Point, tolerance: number) =>
    call<Rings | null>({ op: 'wand', key, point, tolerance }),
  merge: (key: string, regions: Rings[]) => call<Rings | null>({ op: 'merge', key, regions }),
  split: (key: string, rings: Rings, line: Point[]) =>
    call<Rings[] | null>({ op: 'split', key, rings, line }),
}
