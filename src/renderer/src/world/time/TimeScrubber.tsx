import { useEffect, useState } from 'react'
import type { WorldData } from '../useWorld'
import { useTime } from './TimeContext'
import { nowLabel, stopLabel } from './timeModel'

/** How long playback rests on each stop. */
const PLAY_MS = 1400

/**
 * The time scrubber: the world's eras as bands, events as ticks, the story's
 * chapters as markers, and "now" at the end. Moving it changes everything
 * below to that moment. Play steps through the story.
 */
export function TimeScrubber(props: { world: WorldData }) {
  const { world } = props
  const { stop, setStop, enabled } = useTime()
  const [playing, setPlaying] = useState(false)
  const { stops, eras } = world.timeline
  // One slot per stop, and a last one for "now".
  const last = stops.length
  const found = stop ? stops.findIndex((s) => s.id === stop.id) : -1
  const index = found >= 0 ? found : last

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(() => {
      const next = index + 1
      if (next >= last) {
        setStop(null)
        setPlaying(false)
      } else setStop(stops[next]!)
    }, PLAY_MS)
    return () => clearTimeout(timer)
  }, [playing, index, last, stops, setStop])

  // Nothing to scrub through yet (no chapters, eras or events): no scrubber.
  if (!enabled || !stops.length) return null
  const pct = (i: number) => (last === 0 ? 100 : (i / last) * 100)
  const label = index === last ? nowLabel(world) : stopLabel(world, stops[index]!)
  const play = () => {
    if (playing) return setPlaying(false)
    // From now, play the story from its first chapter.
    if (index === last) {
      const first = stops.find((s) => s.kind === 'chapter') ?? stops[0]
      if (!first) return
      setStop(first)
    }
    setPlaying(true)
  }
  const bands = eras.map((era) => {
    const from = stops.findIndex((s) => s.id === era.id)
    const to = stops.findIndex((s) => s.position >= era.end)
    return { era, from, to: to < 0 ? last : to }
  })

  return (
    <div className="time-scrubber" role="group" aria-label="Time">
      <button
        className="icon scrubber-play"
        aria-label={playing ? 'Pause' : 'Play the story'}
        title={playing ? 'Pause' : 'Play the story: step through it chapter by chapter'}
        disabled={!stops.length}
        onClick={play}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="scrubber-body">
        <div className="scrubber-marks" aria-hidden>
          {bands.map(({ era, from, to }, i) => (
            <span
              key={era.id}
              className={`scrubber-era era-${i % 4}`}
              style={{ left: `${pct(from)}%`, width: `${pct(to) - pct(from)}%` }}
              title={world.resolve(era.id)?.name}
            >
              {world.resolve(era.id)?.name}
            </span>
          ))}
          {stops.map((s, i) => (
            <span
              key={s.id}
              className={`scrubber-tick ${s.kind}`}
              style={{ left: `${pct(i)}%` }}
              title={stopLabel(world, s)}
            />
          ))}
          <span className="scrubber-tick now" style={{ left: '100%' }} title="Now" />
        </div>
        <input
          type="range"
          className="scrubber-range"
          min={0}
          max={last}
          step={1}
          value={index}
          aria-label="Moment"
          aria-valuetext={label}
          onChange={(e) => {
            setPlaying(false)
            const i = Number(e.target.value)
            setStop(i >= last ? null : stops[i]!)
          }}
        />
      </div>
      <span className="scrubber-label" role="status">
        {label}
      </span>
      {index !== last && (
        <button
          className="link small"
          onClick={() => {
            setPlaying(false)
            setStop(null)
          }}
        >
          Back to now
        </button>
      )}
    </div>
  )
}

/** A quiet note on pages shown at an earlier moment, with a way back to now. */
export function MomentNote(props: { world: WorldData }) {
  const { stop, setStop } = useTime()
  if (!stop) return null
  return (
    <p className="moment-note small" role="note">
      As of {stopLabel(props.world, stop)}.{' '}
      <button className="link" onClick={() => setStop(null)}>
        Back to now
      </button>
    </p>
  )
}
