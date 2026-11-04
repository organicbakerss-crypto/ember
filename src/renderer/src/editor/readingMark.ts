/** Marks the paragraph being read aloud (a decoration, so the editor's redraws keep it). */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const readingKey = new PluginKey<number | null>('readingMark')

/** A transaction that marks the block at `pos` (null: none). */
export const markReadingTr = (state: EditorState, pos: number | null): Transaction =>
  state.tr.setMeta(readingKey, pos).setMeta('addToHistory', false)

export const ReadingMark = Extension.create({
  name: 'readingMark',
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: readingKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const next = tr.getMeta(readingKey) as number | null | undefined
            if (next !== undefined) return next
            return value === null ? null : tr.mapping.map(value)
          },
        },
        props: {
          decorations(state) {
            const pos = readingKey.getState(state)
            if (pos === null || pos === undefined) return null
            const node = state.doc.nodeAt(pos)
            if (!node) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: 'reading-now' }),
            ])
          },
        },
      }),
    ]
  },
})
