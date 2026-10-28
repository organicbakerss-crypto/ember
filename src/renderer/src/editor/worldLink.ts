/**
 * Explicit links on world pages: typing `@` opens a picker, and the chosen
 * entry's name goes into the text marked with a link to it. The mark carries
 * the entry's id, so the link survives renames. It looks and behaves like a
 * linked name (hover for the card, Ctrl/Cmd+click to open).
 */
import { Extension, Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

export interface MentionTrigger {
  query: string
  /** Document range of `@query`, replaced by the link. */
  from: number
  to: number
  /** Where the `@` is on screen. */
  rect: { left: number; top: number; bottom: number }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    worldLink: {
      insertWorldLink: (
        range: { from: number; to: number },
        entryId: string,
        name: string,
      ) => ReturnType
    }
    mentionTrigger: {
      onMentionTrigger: (listener: ((trigger: MentionTrigger | null) => void) | null) => ReturnType
    }
  }
  interface Storage {
    mentionTrigger: { listener: ((trigger: MentionTrigger | null) => void) | null }
  }
}

export const WorldLink = Mark.create({
  name: 'worldLink',
  inclusive: false,
  addAttributes() {
    return {
      entryId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-entry-id'),
        renderHTML: (attrs) => ({ 'data-entry-id': attrs['entryId'] as string }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-world-link]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-world-link': '', class: 'entity-link world-link' }),
      0,
    ]
  },
  addCommands() {
    return {
      insertWorldLink:
        (range, entryId, name) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt(range, [
              { type: 'text', text: name, marks: [{ type: 'worldLink', attrs: { entryId } }] },
              { type: 'text', text: ' ' },
            ])
            .run(),
    }
  },
})

const TRIGGER = /(?:^|[\s(“"‘'—])@([\p{L}\p{N}'’ -]{0,40})$/u
const key = new PluginKey('mentionTrigger')

export const MentionTrigger = Extension.create<
  object,
  { listener: ((trigger: MentionTrigger | null) => void) | null }
>({
  name: 'mentionTrigger',
  addStorage() {
    return { listener: null }
  },
  addCommands() {
    return {
      onMentionTrigger: (listener) => () => {
        this.storage.listener = listener
        return true
      },
    }
  },
  addProseMirrorPlugins() {
    const storage = this.storage
    let last: string | null = null
    return [
      new Plugin({
        key,
        view: () => ({
          update(view) {
            const { selection } = view.state
            let trigger: MentionTrigger | null = null
            if (selection.empty && view.hasFocus()) {
              const $pos = selection.$from
              const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼')
              const match = TRIGGER.exec(before)
              if (match && !match[1]!.startsWith(' ')) {
                const from = selection.from - match[1]!.length - 1
                const coords = view.coordsAtPos(from)
                trigger = {
                  query: match[1]!,
                  from,
                  to: selection.from,
                  rect: { left: coords.left, top: coords.top, bottom: coords.bottom },
                }
              }
            }
            const signature = trigger ? `${trigger.from}:${trigger.query}` : null
            if (signature === last) return
            last = signature
            storage.listener?.(trigger)
          },
        }),
      }),
    ]
  },
})
