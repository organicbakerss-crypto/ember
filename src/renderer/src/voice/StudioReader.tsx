import { useEffect, useRef, useState } from 'react'
import { planPassages, type Passage } from '@shared/voice/passages'
import { api, describeError, useIpcEvent } from '../api'

/** How many passages are made ahead of the one playing. */
const AHEAD = 2
/** Below this (of full scale) counts as silence when trimming a clip's ends. */
const SILENCE = 0.01
/** Silence kept at a trimmed end, in seconds. */
const KEEP = 0.04

/** A clip with the silence the engine puts at its ends cut off. */
function trimmed(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const data = buf.getChannelData(0)
  let start = 0
  let end = data.length - 1
  while (start < end && Math.abs(data[start]!) < SILENCE) start++
  while (end > start && Math.abs(data[end]!) < SILENCE) end--
  const keep = Math.round(KEEP * buf.sampleRate)
  start = Math.max(0, start - keep)
  end = Math.min(data.length - 1, end + keep)
  const out = ctx.createBuffer(buf.numberOfChannels, end - start + 1, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).slice(start, end + 1), c)
  }
  return out
}

/**
 * Reads the chapter aloud with VoiceStudio, each character in their voice:
 * who says what comes from the AI's marking, the voices from the story's
 * cast. Passages are made a little ahead, trimmed, and played back to back
 * with the app's own pauses. "Preparing…" while it waits; it never skips.
 */
export function StudioReader(props: {
  seriesId: string
  volumeId: string
  chapterId: string
  blocks: { pos: number; text: string | null }[]
  mark: (pos: number | null) => void
  onClose: () => void
}) {
  const { seriesId, volumeId, chapterId, blocks, mark, onClose } = props
  const [state, setState] = useState<{ text: string; at: number; of: number }>({
    text: 'Getting ready…',
    at: 0,
    of: 0,
  })
  const [paused, setPaused] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const [requestId] = useState(() => `speakers-${Date.now()}`)

  useIpcEvent('ai:progress', (p) => {
    if (p.requestId === requestId && p.text) setState((s) => ({ ...s, text: p.text }))
  })

  useEffect(() => {
    let stopped = false
    const ctx = new AudioContext()
    ctxRef.current = ctx
    const made = new Map<number, Promise<AudioBuffer>>()
    const make = (p: Passage) =>
      api
        .invoke('voice:speak', { text: p.text, voice: p.voice })
        .then((wav) => ctx.decodeAudioData(wav.slice().buffer))
        .then((buf) => trimmed(ctx, buf))
    const run = async () => {
      const [speakers, cast] = await Promise.all([
        api.invoke('voice:chapterSpeakers', { requestId, seriesId, volumeId, chapterId }),
        api.invoke('voice:cast', { seriesId }),
      ])
      const passages = planPassages(blocks, speakers, cast)
      if (!passages.length) return onClose()
      // One at a time, in order (VoiceStudio makes one passage at a time anyway).
      let queue: Promise<unknown> = Promise.resolve()
      const fetch = (i: number) => {
        if (i < passages.length && !made.has(i)) {
          const next = queue.then(() => make(passages[i]!))
          queue = next.catch(() => {})
          made.set(i, next)
        }
        return made.get(i)
      }
      for (let i = 0; i < passages.length; i++) {
        if (stopped) return
        void fetch(i)
        for (let k = 1; k <= AHEAD; k++) void fetch(i + k)?.catch(() => {})
        setState({ text: 'Preparing…', at: i + 1, of: passages.length })
        const buf = await fetch(i)!
        if (stopped) return
        const p = passages[i]!
        if (p.pauseBefore) await new Promise((r) => setTimeout(r, p.pauseBefore))
        mark(blocks[p.blocks[0]!]?.pos ?? null)
        setState({ text: 'Reading aloud', at: i + 1, of: passages.length })
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource()
          src.buffer = buf
          src.connect(ctx.destination)
          src.onended = () => resolve()
          src.start()
        })
        made.delete(i)
      }
      if (!stopped) onClose()
    }
    run().catch((err) => {
      if (!stopped) setProblem(describeError(err).message)
    })
    return () => {
      stopped = true
      void ctx.close()
      mark(null)
    }
  }, [seriesId, volumeId, chapterId, blocks, mark, onClose, requestId])

  const toggle = () => {
    const ctx = ctxRef.current
    if (!ctx) return
    if (paused) void ctx.resume()
    else void ctx.suspend()
    setPaused(!paused)
  }

  return (
    <div className="read-aloud" role="region" aria-label="Reading aloud">
      {problem ? (
        <span className="small">Reading aloud stopped: {problem}</span>
      ) : (
        <span className="small">
          {paused ? 'Paused' : state.text}
          {state.of ? ` · ${state.at} of ${state.of}` : ''}
        </span>
      )}
      {!problem && <button onClick={toggle}>{paused ? 'Resume' : 'Pause'}</button>}
      <button onClick={onClose}>{problem ? 'Close' : 'Stop'}</button>
    </div>
  )
}
