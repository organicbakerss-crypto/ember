import { useCallback, useEffect, useState } from 'react'
import type { OutlineView } from '@shared/ipc'
import type { OutlineFile, VolumeFile } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { ChapterPane } from './ChapterPane'
import { InlineCreate } from './InlineCreate'

/**
 * A bare outline: arcs and chapters, with simple move up/down. Drag-and-drop
 * arrives with the binder in the Writing core milestone.
 */
export function VolumeView(props: { seriesId: string; volume: VolumeFile }) {
  const { seriesId, volume } = props
  const ref = { seriesId, volumeId: volume.id }
  const [view, setView] = useState<OutlineView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chapterId, setChapterId] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .invoke('outline:get', { seriesId, volumeId: volume.id })
      .then(setView, (err) => setError(describeError(err).message))
  }, [seriesId, volume.id])
  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (change) => {
    if ((change.kind === 'outline' || change.kind === 'chapter') && change.volumeId === volume.id) {
      refresh()
    }
  })

  const save = async (items: OutlineFile['items']) => {
    if (!view) return
    try {
      setView(await api.invoke('outline:save', { ...ref, outline: { ...view.outline, items } }))
      setError(null)
    } catch (err) {
      setError(describeError(err).message)
      refresh()
    }
  }

  const createChapter = async (title: string, arcId?: string) => {
    const chapter = await api.invoke('chapter:create', { ...ref, title, arcId })
    setChapterId(chapter.id)
  }

  if (!view) return error ? <p className="error">{error}</p> : null
  const items = view.outline.items
  const title = (id: string) => view.chapters[id]?.title || 'Untitled chapter'

  const moveItem = (index: number, delta: number) => void save(move(items, index, delta))
  const moveInArc = (arcIndex: number, index: number, delta: number) => {
    const arc = items[arcIndex]
    if (arc?.type !== 'arc') return
    const next = [...items]
    next[arcIndex] = { ...arc, chapterIds: move(arc.chapterIds, index, delta) }
    void save(next)
  }

  const chapterRow = (
    id: string,
    onMove: (delta: number) => void,
    first: boolean,
    last: boolean,
  ) => (
    <div className="outline-row">
      <button
        className={`tree-item ${id === chapterId ? 'selected' : ''}`}
        onClick={() => setChapterId(id)}
      >
        {title(id)}
      </button>
      <MoveButtons onMove={onMove} first={first} last={last} />
    </div>
  )

  return (
    <div className="volume">
      <section className="outline">
        <h2>{volume.name}</h2>
        {error && <p className="error">{error}</p>}
        {view.problems.map((p) => (
          <p key={p.path} className="warning small">
            {p.message}
          </p>
        ))}
        <ul className="tree">
          {items.map((item, i) =>
            item.type === 'arc' ? (
              <li key={item.id} className="arc">
                <div className="outline-row">
                  <strong className="tree-label">{item.name}</strong>
                  <MoveButtons
                    onMove={(d) => moveItem(i, d)}
                    first={i === 0}
                    last={i === items.length - 1}
                  />
                </div>
                <ul>
                  {item.chapterIds.map((id, j) => (
                    <li key={id}>
                      {chapterRow(
                        id,
                        (d) => moveInArc(i, j, d),
                        j === 0,
                        j === item.chapterIds.length - 1,
                      )}
                    </li>
                  ))}
                  <li>
                    <InlineCreate
                      label="Chapter"
                      placeholder="Chapter title"
                      allowEmpty
                      onCreate={(t) => createChapter(t, item.id)}
                    />
                  </li>
                </ul>
              </li>
            ) : (
              <li key={item.id}>
                {chapterRow(item.id, (d) => moveItem(i, d), i === 0, i === items.length - 1)}
              </li>
            ),
          )}
        </ul>
        <div className="row">
          <InlineCreate
            label="Chapter"
            placeholder="Chapter title"
            allowEmpty
            onCreate={(t) => createChapter(t)}
          />
          <InlineCreate
            label="Arc"
            placeholder="Arc name"
            onCreate={(name) => api.invoke('arc:create', { ...ref, name })}
          />
        </div>
      </section>
      {chapterId && (
        <ChapterPane
          key={chapterId}
          seriesId={seriesId}
          volumeId={volume.id}
          chapterId={chapterId}
        />
      )}
    </div>
  )
}

function MoveButtons(props: { onMove: (delta: number) => void; first: boolean; last: boolean }) {
  return (
    <span className="move-buttons">
      <button
        className="icon"
        title="Move up"
        disabled={props.first}
        onClick={() => props.onMove(-1)}
      >
        ↑
      </button>
      <button
        className="icon"
        title="Move down"
        disabled={props.last}
        onClick={() => props.onMove(1)}
      >
        ↓
      </button>
    </span>
  )
}

function move<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list]
  const target = index + delta
  if (target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item as T)
  return next
}
