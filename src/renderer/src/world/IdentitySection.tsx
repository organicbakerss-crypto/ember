import { useState } from 'react'
import type { EntryIdentity, EntryName, FactAnchor, WorldEntryFile } from '@shared/schema'
import { chapterName } from '@shared/world/story'
import { isIndividualTemplate } from '@shared/world/templates'
import type { WorldData } from './useWorld'
import { anchorFromKey, anchorKey } from './FactEditor'

const KINDS: { id: EntryName['kind']; label: string }[] = [
  { id: 'nickname', label: 'Nickname' },
  { id: 'alias', label: 'Alias' },
  { id: 'disguise', label: 'Disguise' },
  { id: 'secret', label: 'Secret identity' },
]

/**
 * A person's other names (who uses each, what kind, from when) and who they
 * are over the story: the same person as another entry (revealed at some
 * point), or becoming someone else.
 */
export function IdentitySection(props: {
  world: WorldData
  entry: WorldEntryFile
  onSave: (patch: { names?: EntryName[]; identities?: EntryIdentity[] }, label: string) => void
  onOpen: (entryId: string) => void
}) {
  const { world, entry } = props
  const [adding, setAdding] = useState<null | 'name' | 'same' | 'becomes'>(null)
  const chapters = world.index?.chapters ?? []
  const people = world.view.entries
    .filter(
      (e) =>
        e.id !== entry.id &&
        isIndividualTemplate(
          world.templates.get(e.template) ?? { id: e.template, name: '', lens: 'who' },
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  const nameOf = (id: string) => world.resolve(id)?.name ?? '(gone)'
  const chapterOf = (at: FactAnchor | null) => {
    if (at?.kind !== 'chapter') return null
    const c = chapters.find((x) => x.id === at.chapterId)
    return c ? chapterName(c) : null
  }
  const names = entry.names ?? []
  const identities = entry.identities ?? []
  // Links held by others that point here.
  const theirs = world.view.entries.flatMap((other) =>
    (other.identities ?? []).filter((l) => l.entryId === entry.id).map((l) => ({ other, link: l })),
  )

  const when = (
    value: FactAnchor | null,
    onChange: (a: FactAnchor | null) => void,
    label: string,
    first: string,
  ) => (
    <select
      aria-label={label}
      value={anchorKey(value)}
      onChange={(e) => onChange(anchorFromKey(e.target.value))}
    >
      <option value="">{first}</option>
      {chapters.map((c) => (
        <option key={c.id} value={`c:${c.id}`}>
          {chapterName(c)}
        </option>
      ))}
    </select>
  )
  const setName = (id: string, patch: Partial<EntryName>, label: string) =>
    props.onSave({ names: names.map((n) => (n.id === id ? { ...n, ...patch } : n)) }, label)
  const setIdentity = (i: number, patch: Partial<EntryIdentity>, label: string) =>
    props.onSave(
      { identities: identities.map((l, j) => (j === i ? { ...l, ...patch } : l)) },
      label,
    )

  return (
    <section className="entry-section identity-section" aria-label="Names and who they are">
      <h2 className="small">Names and who they are</h2>
      {names.length === 0 && identities.length === 0 && theirs.length === 0 && (
        <p className="muted small">
          Other names (what someone calls them, a disguise, a secret identity), and whether they’re
          the same person as someone else here, or become someone else.
        </p>
      )}
      {names.length > 0 && (
        <ul className="identity-list">
          {names.map((n) => (
            <li key={n.id} className="identity-row">
              <input
                aria-label="The name"
                defaultValue={n.name}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== n.name) setName(n.id, { name: v }, `Renamed “${n.name}” to “${v}”`)
                }}
              />
              <select
                aria-label="What kind of name"
                value={n.kind}
                onChange={(e) =>
                  setName(
                    n.id,
                    { kind: e.target.value as EntryName['kind'] },
                    `“${n.name}” is now a ${e.target.value}`,
                  )
                }
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Who uses it"
                value={n.usedBy[0] ?? ''}
                onChange={(e) =>
                  setName(
                    n.id,
                    { usedBy: e.target.value ? [e.target.value] : [] },
                    `Who calls them “${n.name}” changed`,
                  )
                }
              >
                <option value="">Used by everyone</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    What {p.name} calls them
                  </option>
                ))}
              </select>
              {when(
                n.from,
                (from) => setName(n.id, { from }, `“${n.name}” now starts later`),
                'From when',
                'From the start',
              )}
              <button
                className="icon"
                aria-label={`Remove the name ${n.name}`}
                onClick={() =>
                  props.onSave(
                    { names: names.filter((x) => x.id !== n.id) },
                    `Removed the name “${n.name}”`,
                  )
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {(identities.length > 0 || theirs.length > 0) && (
        <ul className="identity-list">
          {identities.map((l, i) => (
            <li key={`${l.kind}-${l.entryId}`} className="identity-row">
              <select
                aria-label="How they're linked"
                value={l.kind}
                onChange={(e) =>
                  setIdentity(
                    i,
                    { kind: e.target.value as EntryIdentity['kind'] },
                    'Changed how they’re linked',
                  )
                }
              >
                <option value="same">Same person as</option>
                <option value="becomes">Becomes</option>
              </select>
              <button className="link" onClick={() => props.onOpen(l.entryId)}>
                {nameOf(l.entryId)}
              </button>
              {when(
                l.at,
                (at) => setIdentity(i, { at }, 'Changed when'),
                l.kind === 'same' ? 'Revealed in' : 'From',
                l.kind === 'same' ? 'Known from the start' : 'From the start',
              )}
              <button
                className="icon"
                aria-label={`Remove the link to ${nameOf(l.entryId)}`}
                onClick={() =>
                  props.onSave(
                    { identities: identities.filter((_, j) => j !== i) },
                    `Unlinked from ${nameOf(l.entryId)}`,
                  )
                }
              >
                ✕
              </button>
            </li>
          ))}
          {theirs.map(({ other, link }) => (
            <li key={`theirs-${other.id}`} className="identity-row muted small">
              {link.kind === 'same' ? 'Same person as ' : 'Was '}
              <button className="link" onClick={() => props.onOpen(other.id)}>
                {other.name}
              </button>
              {chapterOf(link.at) &&
                ` (${link.kind === 'same' ? 'revealed in' : 'until'} ${chapterOf(link.at)})`}
              <span className="muted"> · set on {other.name}’s page</span>
            </li>
          ))}
        </ul>
      )}
      {adding === null ? (
        <div className="row small">
          <button className="link" onClick={() => setAdding('name')}>
            + A name
          </button>
          <button className="link" onClick={() => setAdding('same')}>
            + Same person as…
          </button>
          <button className="link" onClick={() => setAdding('becomes')}>
            + Becomes…
          </button>
        </div>
      ) : adding === 'name' ? (
        <AddName
          people={people}
          onCancel={() => setAdding(null)}
          onAdd={(n) => {
            setAdding(null)
            props.onSave({ names: [...names, n] }, `Added the name “${n.name}”`)
          }}
        />
      ) : (
        <div className="row small">
          <span>{adding === 'same' ? 'Same person as' : 'Becomes'}</span>
          <select
            aria-label="Who"
            autoFocus
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              setAdding(null)
              props.onSave(
                { identities: [...identities, { kind: adding, entryId: id, at: null }] },
                `${adding === 'same' ? 'Same person as' : 'Becomes'} ${nameOf(id)}`,
              )
            }}
          >
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="link" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      )}
    </section>
  )
}

function AddName(props: {
  people: { id: string; name: string }[]
  onAdd: (name: EntryName) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [usedBy, setUsedBy] = useState('')
  const [kind, setKind] = useState<EntryName['kind']>('nickname')
  const add = () => {
    if (!name.trim()) return
    props.onAdd({
      id: `nm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      usedBy: usedBy ? [usedBy] : [],
      kind,
      from: null,
    })
  }
  return (
    <div className="identity-row">
      <input
        aria-label="New name"
        autoFocus
        placeholder="Dad, the Captain…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
          if (e.key === 'Escape') props.onCancel()
        }}
      />
      <select
        aria-label="What kind of name"
        value={kind}
        onChange={(e) => setKind(e.target.value as EntryName['kind'])}
      >
        {KINDS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      <select aria-label="Who uses it" value={usedBy} onChange={(e) => setUsedBy(e.target.value)}>
        <option value="">Used by everyone</option>
        {props.people.map((p) => (
          <option key={p.id} value={p.id}>
            What {p.name} calls them
          </option>
        ))}
      </select>
      <button className="primary small" disabled={!name.trim()} onClick={add}>
        Add
      </button>
      <button className="link small" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  )
}
