/**
 * Linked names: names of world entries (and their aliases) are marked in the
 * text. Hovering one reports it (for a hover card); Ctrl/Cmd+click opens the
 * entry. Like the other highlights, these are view-only decorations: the
 * chapter text itself never changes.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { nameMatcher, type NameMatcher, type NameTerm } from '@shared/names'

export const LINK_DELAY_MS = 400

export interface LinkHover {
  entryId: string
  /** Where the name is on screen, to place the card. */
  rect: DOMRect
}

interface LinkedNamesStorage {
  matcher: NameMatcher
  enabled: boolean
  onHover: ((hover: LinkHover | null) => void) | null
  onOpen: ((entryId: string) => void) | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    linkedNames: {
      setLinkedNames: (terms: NameTerm[], enabled: boolean) => ReturnType
      onLinkedNames: (handlers: {
        onHover: LinkedNamesStorage['onHover']
        onOpen: LinkedNamesStorage['onOpen']
      }) => ReturnType
    }
  }
  interface Storage {
    linkedNames: LinkedNamesStorage
  }
}

const key = new PluginKey<{ decorations: DecorationSet; stale: boolean }>('linkedNames')

export const LinkedNames = Extension.create<object, LinkedNamesStorage>({
  name: 'linkedNames',

  addStorage() {
    return { matcher: nameMatcher([]), enabled: false, onHover: null, onOpen: null }
  },

  addCommands() {
    return {
      setLinkedNames:
        (terms, enabled) =>
        ({ tr }) => {
          this.storage.matcher = nameMatcher(terms)
          this.storage.enabled = enabled
          tr.setMeta(key, 'stale')
          return true
        },
      onLinkedNames: (handlers) => () => {
        this.storage.onHover = handlers.onHover
        this.storage.onOpen = handlers.onOpen
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const linkAt = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('.entity-link') : null

    return [
      new Plugin({
        key,
        state: {
          init: () => ({ decorations: DecorationSet.empty, stale: true }),
          apply(tr, value) {
            const meta = tr.getMeta(key) as DecorationSet | 'stale' | undefined
            if (meta instanceof DecorationSet) return { decorations: meta, stale: false }
            return {
              decorations: value.decorations.map(tr.mapping, tr.doc),
              stale: value.stale || meta === 'stale',
            }
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          handleDOMEvents: {
            mouseover(_view, event) {
              const link = linkAt(event.target)
              if (link?.dataset['entryId']) {
                storage.onHover?.({
                  entryId: link.dataset['entryId'],
                  rect: link.getBoundingClientRect(),
                })
              }
              return false
            },
            mouseout(_view, event) {
              if (linkAt(event.target) && !linkAt(event.relatedTarget)) storage.onHover?.(null)
              return false
            },
            mousedown(_view, event) {
              // Ctrl/Cmd+click opens the entry; a plain click just places the cursor.
              const link = linkAt(event.target)
              if (link?.dataset['entryId'] && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                storage.onOpen?.(link.dataset['entryId'])
                return true
              }
              return false
            },
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const schedule = (delay: number) => {
            clearTimeout(timer)
            timer = setTimeout(() => !view.isDestroyed && recalculate(view, storage), delay)
          }
          schedule(0)
          return {
            update(v, prev) {
              if (key.getState(v.state)?.stale) schedule(0)
              else if (v.state.doc !== prev.doc) schedule(LINK_DELAY_MS)
            },
            destroy: () => clearTimeout(timer),
          }
        },
      }),
    ]
  },
})

function recalculate(view: EditorView, storage: LinkedNamesStorage): void {
  const decorations: Decoration[] = []
  if (storage.enabled) {
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      // Text of the block, with each character's document position.
      let text = ''
      const positions: number[] = []
      node.forEach((child, offset) => {
        if (child.isText) {
          text += child.text
          for (let i = 0; i < child.text!.length; i++) positions.push(pos + 1 + offset + i)
        } else {
          text += child.type.name === 'hardBreak' ? '\n' : ' '
          positions.push(pos + 1 + offset)
        }
      })
      for (const m of storage.matcher.find(text)) {
        decorations.push(
          Decoration.inline(positions[m.start]!, positions[m.end - 1]! + 1, {
            class: 'entity-link',
            'data-entry-id': m.entryId,
          }),
        )
      }
      return false
    })
  }
  view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, decorations)))
}
