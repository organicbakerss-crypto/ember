/**
 * Runs region detection off the page's thread, so the window stays smooth
 * while OpenCV works. The image's pixels are sent once per map; the smoothed
 * copy every tool works on is made once and kept.
 */
// Imported statically: a dynamic import() of this module never settles (it looks like a promise).
import * as openCvModule from '@techstark/opencv-js'
import {
  detect,
  loadOpenCv,
  magicWand,
  mergeOutlines,
  prepare,
  splitOutline,
  type Pixels,
  type Prepared,
} from './detect'
import type { DetectRequest } from './detectClient'

let image: { key: string; pixels: Pixels; prepared: Prepared | null } | null = null
/** The worker's own scope (typed by hand: the page's DOM types describe a window). */
const scope = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent<DetectRequest & { id: number }>) => void) | null
}

scope.onmessage = async (event) => {
  const { id, ...request } = event.data
  try {
    if (request.op === 'load') {
      image?.prepared?.delete()
      image = { key: request.key, pixels: request.pixels, prepared: null }
      scope.postMessage({ id, result: null })
      return
    }
    const { cv } = await loadOpenCv(async () => ({ module: openCvModule }))
    if (!image || image.key !== request.key) throw new Error('The map image is not loaded.')
    const p = (image.prepared ??= prepare(cv, image.pixels))
    const result =
      request.op === 'detect'
        ? detect(cv, p, request.method, request.seaPoint)
        : request.op === 'wand'
          ? magicWand(cv, p, request.point, request.tolerance, request.base)
          : request.op === 'merge'
            ? mergeOutlines(cv, request.regions, p.width, p.height)
            : splitOutline(cv, request.rings, request.line, p.width, p.height)
    scope.postMessage({ id, result })
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
