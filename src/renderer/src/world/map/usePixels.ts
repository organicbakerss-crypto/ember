import { useEffect, useState } from 'react'
import type { MapFile } from '@shared/schema'
import { worldImageUrl } from '@shared/media'
import type { Pixels } from './detect'

/** Detection works on a copy at most this many pixels across. */
const WORK_SIDE = 1600
/** Lighter mode shows the map at most this many pixels across. */
const LIGHT_SIDE = 1200

export interface MapPixels {
  /** Identifies the image in the detection worker. */
  key: string
  pixels: Pixels
  /** Working-copy pixels per image pixel. */
  scale: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The map image could not be loaded.'))
    img.src = src
  })
}

function draw(img: HTMLImageElement, side: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { canvas, scale }
}

/** The map's pixels at working size, loaded only when a detection tool needs them. */
export async function mapPixels(worldId: string, map: MapFile): Promise<MapPixels> {
  const img = await loadImage(worldImageUrl(worldId, map.image!.file))
  const { canvas, scale } = draw(img, WORK_SIDE)
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
  return {
    key: map.image!.file,
    pixels: { data: data.data, width: data.width, height: data.height },
    scale,
  }
}

/** The address to show the map image at: full size, or a smaller copy in lighter mode. */
export function useMapImage(worldId: string, map: MapFile, lighter: boolean): string {
  const full = worldImageUrl(worldId, map.image!.file)
  const [small, setSmall] = useState<{ file: string; url: string } | null>(null)
  useEffect(() => {
    if (!lighter) return
    let url: string | null = null
    let cancelled = false
    void loadImage(full)
      .then((img) => {
        const { canvas } = draw(img, LIGHT_SIDE)
        return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8))
      })
      .then((blob) => {
        if (!blob || cancelled) return
        url = URL.createObjectURL(blob)
        setSmall({ file: map.image!.file, url })
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [lighter, full, map.image])
  return lighter && small?.file === map.image!.file ? small.url : full
}
