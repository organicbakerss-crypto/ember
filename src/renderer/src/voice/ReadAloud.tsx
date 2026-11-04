import { useEffect, useRef, useState } from 'react'
import type { VoiceSettings } from '@shared/settings'
import { speakable } from '@shared/voice/script'

/** Pause at a scene break, in milliseconds. */
const BREAK_MS = 900

/**
 * Reads the chapter aloud from the cursor with the computer's voice,
 * highlighting each paragraph as it goes. Text is tidied first (a line break
 * inside a paragraph is not a stop); scene breaks get a short pause.
 */
export function ReadAloud(props: {
  blocks: { pos: number; text: string | null }[]
  settings: VoiceSettings
  mark: (pos: number | null) => void
  onClose: () => void
}) {
  const { blocks, settings, mark, onClose } = props
  const [at, setAt] = useState(0)
  const [paused, setPaused] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const stopped = useRef(false)

  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return
    stopped.current = false
    const voice = speechSynthesis.getVoices().find((v) => v.name === settings.systemVoice)
    let timer: ReturnType<typeof setTimeout> | undefined
    const play = (i: number) => {
      if (stopped.current) return
      if (i >= blocks.length) {
        mark(null)
        onClose()
        return
      }
      setAt(i)
      const b = blocks[i]!
      mark(b.pos)
      const text = b.text === null ? '' : speakable(b.text)
      if (!text) {
        timer = setTimeout(() => play(i + 1), b.text === null ? BREAK_MS : 0)
        return
      }
      const u = new SpeechSynthesisUtterance(text)
      if (voice) u.voice = voice
      u.rate = settings.rate
      u.onend = () => play(i + 1)
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return
        // Speaking failed: stop here (skipping on would race to the end, saying nothing).
        stopped.current = true
        setProblem(noVoiceHelp())
      }
      speechSynthesis.speak(u)
    }
    speechSynthesis.cancel()
    if (!speechSynthesis.getVoices().length) {
      // Voices can arrive a moment late; if there are none after that, say why.
      timer = setTimeout(() => {
        if (speechSynthesis.getVoices().length) play(0)
        else setProblem(noVoiceHelp())
      }, 600)
    } else play(0)
    return () => {
      stopped.current = true
      clearTimeout(timer)
      speechSynthesis.cancel()
      mark(null)
    }
  }, [blocks, settings.systemVoice, settings.rate, mark, onClose])

  const toggle = () => {
    if (paused) speechSynthesis.resume()
    else speechSynthesis.pause()
    setPaused(!paused)
  }

  if (problem) {
    return (
      <div className="read-aloud" role="region" aria-label="Reading aloud">
        <span className="small">{problem}</span>
        <button onClick={onClose}>Close</button>
      </div>
    )
  }
  return (
    <div className="read-aloud" role="region" aria-label="Reading aloud">
      <span className="small">
        {paused ? 'Paused' : 'Reading aloud'} · {at + 1} of {blocks.length}
      </span>
      <button onClick={toggle}>{paused ? 'Resume' : 'Pause'}</button>
      <button onClick={onClose}>Stop</button>
    </div>
  )
}

/** What to do when this computer has no voice to read with. */
function noVoiceHelp(): string {
  return navigator.userAgent.includes('Linux')
    ? 'This computer has no voice to read with. On Linux, install speech-dispatcher and espeak-ng (for example: sudo apt install speech-dispatcher espeak-ng), then restart the app. VoiceStudio’s voices come next.'
    : 'This computer’s voice couldn’t be used. Check Settings → Voice, and that a voice is installed (on a Mac: System Settings → Accessibility → Spoken Content).'
}
