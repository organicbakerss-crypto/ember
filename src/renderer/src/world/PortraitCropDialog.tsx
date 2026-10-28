import { useRef, useState } from 'react'
import type { Portrait as PortraitData } from '@shared/schema'
import { Portrait } from './Portrait'

/** Simple cropping: drag to move the picture, slide to zoom. */
export function PortraitCropDialog(props: {
  worldId: string
  name: string
  portrait: PortraitData
  onDone: (portrait: PortraitData | null) => void
}) {
  const [crop, setCrop] = useState(props.portrait.crop)
  const drag = useRef<{ x: number; y: number; crop: typeof crop } | null>(null)
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const preview = { ...props.portrait, crop }

  return (
    <div className="modal-backdrop" onMouseDown={() => props.onDone(null)}>
      <div
        className="card stack dialog crop-dialog"
        role="dialog"
        aria-label="Adjust portrait"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onDone(null)}
      >
        <h3>Adjust the portrait</h3>
        <div
          className="crop-frame"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, crop }
          }}
          onPointerMove={(e) => {
            const start = drag.current
            if (!start) return
            const box = e.currentTarget.getBoundingClientRect()
            // Dragging the picture right shows more of its left side.
            setCrop({
              ...start.crop,
              x: clamp(start.crop.x - ((e.clientX - start.x) / box.width) * start.crop.size),
              y: clamp(start.crop.y - ((e.clientY - start.y) / box.height) * start.crop.size),
            })
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <Portrait worldId={props.worldId} name={props.name} portrait={preview} size="large" />
        </div>
        <label>
          Zoom
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.01}
            value={1.2 - crop.size}
            onChange={(e) => setCrop({ ...crop, size: 1.2 - Number(e.target.value) })}
          />
        </label>
        <div className="dialog-choices">
          <button className="primary" onClick={() => props.onDone({ ...props.portrait, crop })}>
            Done
          </button>
          <button onClick={() => props.onDone(null)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
