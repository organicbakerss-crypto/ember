import { useEffect, useState } from 'react'
import type { ConversationSummary } from '@shared/ipc'
import { api } from '../api'
import { MemoryView } from './MemoryView'

/**
 * General ideas: the story's ideas (plot threads, scene ideas, what a
 * character is like, things still being decided) as a screen of its own,
 * beside World. Like the world, but for ideas rather than established people,
 * places and things; the world never reads them.
 */
export function IdeasView(props: {
  seriesId: string
  storyName: string
  /** Where Back goes ("Back to writing"). */
  backLabel: string
  onBack: () => void
  /** Opens a conversation an idea came from (in the AI beside the page). */
  onOpenConversation: (id: string) => void
}) {
  const { seriesId } = props
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  useEffect(() => {
    let live = true
    api.invoke('ai:conversations', { seriesId }).then(
      (list) => live && setConversations(list),
      () => {},
    )
    return () => {
      live = false
    }
  }, [seriesId])
  return (
    <main className="ideas-page">
      <header className="ideas-page-head">
        <button className="link" onClick={props.onBack}>
          ← {props.backLabel}
        </button>
        <strong>General ideas</strong>
        <span className="muted small">{props.storyName}</span>
      </header>
      <MemoryView
        onPage
        seriesId={seriesId}
        conversations={conversations}
        onOpenConversation={props.onOpenConversation}
      />
    </main>
  )
}
