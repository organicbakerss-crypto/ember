import { useEffect, useRef, useState } from 'react'
import { api, describeError } from '../api'

/**
 * Dictation with VoiceStudio: listens until Stop, then writes it down at the
 * cursor (quote marks for "quote … end quote", the world's names fixed).
 */
export function Dictation(props: {
  seriesId: string
  onText: (text: string) => void
  onClose: () => void
}) {
  const { seriesId, onText, onClose } = props
  const [phase, setPhase] = useState<'starting' | 'listening' | 'writing'>('starting')
  const [problem, setProblem] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const chunks: Blob[] = []
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : ''
        const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
        r.ondataavailable = (e) => chunks.push(e.data)
        r.onstop = async () => {
          stream?.getTracks().forEach((t) => t.stop())
          if (cancelled) return
          setPhase('writing')
          try {
            const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' })
            const text = await api.invoke('voice:transcribe', {
              audio: new Uint8Array(await blob.arrayBuffer()),
              mime: blob.type,
              seriesId,
            })
            if (text) onText(text)
            onClose()
          } catch (err) {
            setProblem(describeError(err).message)
          }
        }
        recorder.current = r
        r.start()
        setPhase('listening')
      })
      .catch(() =>
        setProblem('The microphone couldn’t be used. Check that one is connected and allowed.'),
      )
    return () => {
      cancelled = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [seriesId, onText, onClose])

  return (
    <div className="read-aloud" role="region" aria-label="Dictation">
      <span className="small">
        {problem ??
          (phase === 'starting'
            ? 'Starting the microphone…'
            : phase === 'listening'
              ? '● Listening… say “quote” and “end quote” for dialogue.'
              : 'Writing it down…')}
      </span>
      {phase === 'listening' && !problem && (
        <button className="primary" onClick={() => recorder.current?.stop()}>
          Stop and write it down
        </button>
      )}
      <button onClick={onClose}>{problem ? 'Close' : 'Cancel'}</button>
    </div>
  )
}
