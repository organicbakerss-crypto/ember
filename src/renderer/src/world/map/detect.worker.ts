/**
 * Runs region detection off the page's thread, so the window stays smooth
 * while OpenCV works. The image's pixels are sent once per map.
 */
// Imported statically: a dynamic import() of this module never settles (it looks like a promise).
import * as openCvModule from '@techstark/opencv-js'
import {
  detectAll,
  loadOpenCv,
  magicWand,
  mergeOutlines,
  splitOutline,
  type Pixels,
} from './detect'
import type { DetectRequest } from './detectClient'

const images = new Map<string, Pixels>()
/** The worker's own scope (typed by hand: the page's DOM types describe a window). */
const scope = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent<DetectRequest & { id: number }>) => void) | null
}

scope.onmessage = async (event) => {
  const { id, ...request } = event.data
  try {
    if (request.op === 'load') {
      images.clear()
      images.set(request.key, request.pixels)
      scope.postMessage({ id, result: null })
      return
    }
    const { cv } = await loadOpenCv(async () => ({ module: openCvModule }))
    const px = images.get(request.key)
    if (!px) throw new Error('The map image is not loaded.')
    const result =
      request.op === 'detectAll'
        ? detectAll(cv, px)
        : request.op === 'wand'
          ? magicWand(cv, px, request.point, request.tolerance)
          : request.op === 'merge'
            ? mergeOutlines(cv, request.regions, px.width, px.height)
            : splitOutline(cv, request.rings, request.line, px.width, px.height)
    scope.postMessage({ id, result })
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
