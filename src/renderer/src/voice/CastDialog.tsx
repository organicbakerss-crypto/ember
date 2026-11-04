import { useEffect, useState } from 'react'
import type { IpcResult } from '@shared/ipc'
import { api, describeError } from '../api'

type Cast = IpcResult<'voice:cast'>

/**
 * Which VoiceStudio voice reads whom in a story: the narrator (third-person
 * chapters, and first-person ones whose narrator has no voice here), anyone
 * not listed ("Other"), and each character. Kept with the story.
 */
export function CastDialog(props: { seriesId: string; characters: string[]; onClose: () => void }) {
  const { seriesId } = props
  const [cast, setCast] = useState<Cast | null>(null)
  const [voices, setVoices] = useState<{ id: string; name: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.invoke('voice:cast', { seriesId }).then(setCast, (e) => setError(describeError(e).message))
    api.invoke('voice:status').then(
      (s) => setVoices(s.studio ? s.voices : []),
      () => setVoices([]),
    )
  }, [seriesId])

  const [trying, setTrying] = useState<string | null>(null)
  /** Speaks a short line in a voice, to hear it before (or after) picking it. */
  const tryVoice = async (voice: string) => {
    setTrying(voice || '(default)')
    try {
      const wav = await api.invoke('voice:speak', {
        text: 'This is how I sound reading your story. Does it sound right to you?',
        voice,
      })
      const ctx = new AudioContext()
      const buf = await ctx.decodeAudioData(wav.slice().buffer)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.onended = () => void ctx.close()
      src.start()
    } catch (e) {
      setError(describeError(e).message)
    } finally {
      setTrying(null)
    }
  }
  const tryButton = (voice: string) => (
    <button
      className="link small"
      disabled={trying !== null}
      title="Hear this voice"
      onClick={() => void tryVoice(voice)}
    >
      {trying === (voice || '(default)') ? 'Making…' : '▶ Try'}
    </button>
  )

  const save = (next: Cast) => {
    setCast(next)
    api
      .invoke('voice:setCast', { seriesId, voices: next })
      .catch((e) => setError(describeError(e).message))
  }
  const pick = (value: string, onChange: (v: string) => void, label: string) => (
    <select
      aria-label={`Voice for ${label}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">VoiceStudio’s default</option>
      {(voices ?? []).map((v) => (
        <option key={v.id} value={v.name}>
          {v.name}
        </option>
      ))}
      {value && voices && !voices.some((v) => v.name === value) && (
        <option value={value}>{value} (not in VoiceStudio now)</option>
      )}
    </select>
  )

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card dialog cast-dialog"
        role="dialog"
        aria-label="Voices for this story"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>Voices for this story</h2>
        {voices && !voices.length && (
          <p className="muted small">
            VoiceStudio isn’t running (or has no saved voices). Start it, then open this again.
          </p>
        )}
        {error && <p className="error small">{error}</p>}
        {cast && (
          <table className="cast-table">
            <tbody>
              <tr>
                <th>Narrator</th>
                <td>
                  {pick(cast.narrator, (v) => save({ ...cast, narrator: v }), 'the narrator')}
                </td>
              </tr>
              <tr>
                <th>Anyone else</th>
                <td>{pick(cast.other, (v) => save({ ...cast, other: v }), 'anyone else')}</td>
                <td>{tryButton(cast.other)}</td>
              </tr>
              {props.characters.map((name) => (
                <tr key={name}>
                  <th>{name}</th>
                  <td>
                    {pick(
                      cast.characters[name] ?? '',
                      (v) => {
                        const characters = { ...cast.characters }
                        if (v) characters[name] = v
                        else delete characters[name]
                        save({ ...cast, characters })
                      },
                      name,
                    )}
                  </td>
                  <td>{tryButton(cast.characters[name] ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          A first-person chapter is read in its POV character’s voice. Lines the AI couldn’t place
          use “Anyone else”.
        </p>
        <div className="row">
          <span className="status-spacer" />
          <button className="primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
