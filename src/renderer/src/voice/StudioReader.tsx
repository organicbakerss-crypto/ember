import { useEffect, useRef, useState } from 'react'
import { planPassages, readyToPlay, type Passage } from '@shared/voice/passages'
import { api, describeError, useIpcEvent } from '../api'

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
 * cast. Speech is made in order from where reading starts; playing waits
 * until enough is made to go straight through ("starting in about…"), then
 * the passages play back to back, trimmed, with the app's own pauses. It
 * never skips; making stops when reading does.
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
  const redo = useRef(false)
  const [redoAsked, setRedoAsked] = useState(false)
  const [requestId] = useState(() => `speakers-${Date.now()}`)

  useIpcEvent('ai:progress', (p) => {
    if (p.requestId === requestId && p.text) setState((s) => ({ ...s, text: p.text }))
  })

  useEffect(() => {
    let stopped = false
    const ctx = new AudioContext()
    ctxRef.current = ctx
    const make = (p: Passage, fresh = false) =>
      api
        .invoke('voice:speak', { text: p.text, voice: p.voice, fresh })
        .then((wav) => ctx.decodeAudioData(wav.slice().buffer))
        .then((buf) => trimmed(ctx, buf))
    const run = async () => {
      const [speakers, cast] = await Promise.all([
        api.invoke('voice:chapterSpeakers', { requestId, seriesId, volumeId, chapterId }),
        api.invoke('voice:cast', { seriesId }),
      ])
      const passages = planPassages(blocks, speakers, cast)
      if (!passages.length) return onClose()
      const total = passages.reduce((n, p) => n + p.text.length, 0)

      // Speech is made in order, one passage after another, while this is open
      // (and only then): how long each took tells how long to wait before playing.
      const made: (AudioBuffer | undefined)[] = []
      const stats = { chars: 0, audio: 0, took: 0 }
      let failure: unknown = null
      // `version` goes up each time a passage is made (or making fails).
      const waker: { wake: (() => void) | null; version: number } = { wake: null, version: 0 }
      const making = (async () => {
        for (let i = 0; i < passages.length && !stopped; i++) {
          const started = performance.now()
          try {
            made[i] = await make(passages[i]!)
          } catch (err) {
            failure = err
            waker.version++
            waker.wake?.()
            return
          }
          stats.chars += passages[i]!.text.length
          stats.audio += made[i]!.duration
          stats.took += (performance.now() - started) / 1000
          waker.version++
          waker.wake?.()
        }
      })()
      void making
      /** Resolves when something new is made since `seen` (at once if it already was). */
      const next = (seen: number) =>
        new Promise<void>((r) => {
          if (waker.version !== seen) r()
          else waker.wake = r
        })

      // Wait until enough is made to play straight through.
      for (;;) {
        const seen = waker.version
        if (stopped) return
        if (failure) throw failure
        const madeCount = made.filter(Boolean).length
        const buffered = made.reduce((n, b) => n + (b?.duration ?? 0), 0)
        const check = readyToPlay({
          madeChars: stats.chars,
          madeAudio: stats.audio,
          madeTook: stats.took,
          buffered,
          remainingChars: total - stats.chars,
        })
        if (check.ready) break
        setState({
          text:
            check.waitSecs === null
              ? 'Preparing…'
              : `Preparing… starting in about ${check.waitSecs < 90 ? `${check.waitSecs} seconds` : `${Math.round(check.waitSecs / 60)} minutes`}`,
          at: madeCount,
          of: passages.length,
        })
        await next(seen)
      }

      for (let i = 0; i < passages.length; i++) {
        // Ran out after all (it slowed down): wait for this one, saying so.
        while (!made[i]) {
          const seen = waker.version
          if (stopped) return
          if (failure) throw failure
          setState({ text: 'Preparing…', at: i + 1, of: passages.length })
          await next(seen)
        }
        if (stopped) return
        const p = passages[i]!
        if (p.pauseBefore) await new Promise((r) => setTimeout(r, p.pauseBefore))
        mark(blocks[p.blocks[0]!]?.pos ?? null)
        setRedoAsked(false)
        setState({ text: 'Reading aloud', at: i + 1, of: passages.length })
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource()
          src.buffer = made[i]!
          src.connect(ctx.destination)
          src.onended = () => resolve()
          src.start()
        })
        if (redo.current) {
          // "Redo that bit": make this passage again (it comes out differently) and replay it.
          redo.current = false
          setState({ text: 'Making that bit again…', at: i + 1, of: passages.length })
          made[i] = await make(p, true)
          i--
          continue
        }
        made[i] = undefined
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
      {!problem && state.text === 'Reading aloud' && (
        <button
          title="The bit playing now sounded wrong: make it again and replay it"
          disabled={redoAsked}
          onClick={() => {
            redo.current = true
            setRedoAsked(true)
          }}
        >
          Redo that bit
        </button>
      )}
      {!problem && <button onClick={toggle}>{paused ? 'Resume' : 'Pause'}</button>}
      <button onClick={onClose}>{problem ? 'Close' : 'Stop'}</button>
    </div>
  )
}
