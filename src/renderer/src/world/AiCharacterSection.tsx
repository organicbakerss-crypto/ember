import { useCallback, useEffect, useState } from 'react'
import type { AiCharacterFile } from '@shared/schema'
import { CHARACTER_TEMPLATE, looksFilled, templateName } from '@shared/ai/storyCharacters'
import { api, describeError, useIpcEvent } from '../api'
import { useOverlays } from '../components/overlays'

const newRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** What "Copy blank template" puts on the clipboard, for filling in with any AI. */
const COPY_TEXT = `Fill in this template for a character from my story, using only what my story shows. Copy real lines of their dialogue where you can. Keep every label exactly as it is.\n\n${CHARACTER_TEMPLATE}`

/**
 * A person entry's AI character: a filled template the AI speaks as, in the
 * AI panel's picker. Shown only while AI is on.
 */
export function AiCharacterSection(props: {
  worldId: string
  entryId: string
  name: string
  /** Shown under its own heading (on the entry page); false where the page already has one. */
  heading?: boolean
}) {
  const { worldId, entryId } = props
  const { toast } = useOverlays()
  const [character, setCharacter] = useState<AiCharacterFile | null | undefined>(undefined)
  const [draft, setDraft] = useState<string | null>(null)
  const [making, setMaking] = useState<string | null>(null) // request id

  const load = useCallback(() => {
    api.invoke('character:list', { worldId }).then(
      (all) => setCharacter(all.find((c) => c.entryId === entryId) ?? null),
      () => setCharacter(null),
    )
  }, [worldId, entryId])
  useEffect(load, [load])
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'world' && c.worldId === worldId) load()
  })

  const save = async (card: string, learned = character?.learned) => {
    // The entry's own spelling unless the card names them differently (a nickname).
    const fromCard = templateName(card)
    const name =
      fromCard && fromCard.toLowerCase() !== props.name.toLowerCase() ? fromCard : props.name
    try {
      const saved = await api.invoke('character:save', {
        worldId,
        character: { id: character?.id, entryId, name, card, learned },
      })
      setCharacter(saved)
      setDraft(null)
    } catch (err) {
      toast(`Not saved: ${describeError(err).message}`)
    }
  }

  const make = async () => {
    const requestId = newRequestId()
    setMaking(requestId)
    try {
      const made = await api.invoke('character:make', { requestId, worldId, entryId })
      setDraft(made.card) // the writer reads it before it is saved
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') toast(e.message)
    } finally {
      setMaking(null)
    }
  }

  const remove = async () => {
    if (!character) return
    try {
      const gone = await api.invoke('character:delete', { worldId, characterId: character.id })
      setCharacter(null)
      toast(`Removed ${gone.name} from the AI panel`, {
        label: 'Undo',
        run: () =>
          api
            .invoke('character:save', {
              worldId,
              character: {
                id: gone.id,
                entryId: gone.entryId,
                name: gone.name,
                card: gone.card,
                learned: gone.learned,
              },
            })
            .then(setCharacter),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const forget = (index: number) => {
    if (!character) return
    void save(
      character.card,
      character.learned.filter((_, i) => i !== index),
    )
  }

  if (character === undefined) return null
  const pasteProblem =
    draft !== null && draft.trim() && !looksFilled(draft)
      ? 'This needs a "Name:" line and at least a few answers.'
      : null

  return (
    <section
      className={props.heading === false ? 'ai-character-section' : 'entry-section'}
      aria-label="AI character"
    >
      {props.heading !== false && <h3>AI character</h3>}
      {draft !== null ? (
        <div className="stack">
          <p className="muted small">
            Read it over and change anything. The AI speaks as {templateName(draft) ?? props.name}{' '}
            from this, and only knows the story up to the chapter you have open.
          </p>
          <textarea
            className="ai-character-card"
            aria-label="Character card"
            rows={16}
            value={draft}
            placeholder={`Paste the filled template here.\n\n${CHARACTER_TEMPLATE}`}
            onChange={(e) => setDraft(e.target.value)}
          />
          {pasteProblem && <p className="error small">{pasteProblem}</p>}
          <div className="row">
            <button
              className="primary"
              disabled={!draft.trim() || !!pasteProblem}
              onClick={() => void save(draft)}
            >
              Save
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : making ? (
        <div className="row">
          <span className="muted small">Reading the story for {props.name}…</span>
          <button onClick={() => void api.invoke('ai:cancel', { requestId: making })}>Stop</button>
        </div>
      ) : character ? (
        <div className="stack">
          <p className="muted small">
            Talk to {character.name} in the AI panel (pick them from the list).
          </p>
          <pre className="ai-character-card">{character.card}</pre>
          <div className="row">
            <button onClick={() => setDraft(character.card)}>Edit</button>
            <button onClick={() => void make()}>Remake with AI</button>
            <button className="danger" onClick={() => void remove()}>
              Remove
            </button>
          </div>
          {character.learned.length > 0 && (
            <>
              <h4>Picked up from the chapters</h4>
              <ul className="ai-character-learned">
                {character.learned.map((n, i) => (
                  <li key={`${n.at}-${i}`}>
                    {n.text}
                    <button
                      className="icon"
                      aria-label="Forget this"
                      title="Forget this"
                      onClick={() => forget(i)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">Make {props.name} someone you can talk to in the AI panel.</p>
          <div className="row">
            <button onClick={() => void make()}>Make with AI</button>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(COPY_TEXT)
                  .then(() => toast('Template copied. Fill it in with any AI, then paste it here.'))
              }
            >
              Copy blank template
            </button>
            <button onClick={() => setDraft('')}>Paste a filled template</button>
          </div>
        </div>
      )}
    </section>
  )
}
