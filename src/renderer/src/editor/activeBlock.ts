/**
 * Marks the paragraph with the cursor (class `active-block`), so a theme can
 * light it up (Cyberpunk's faint glow). Nothing changes in the document.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const ActiveBlock = Extension.create({
  name: 'activeBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('activeBlock'),
        props: {
          decorations(state) {
            const $head = state.selection.$head
            if ($head.depth < 1 || !$head.parent.isTextblock) return null
            const from = $head.before($head.depth)
            return DecorationSet.create(state.doc, [
              Decoration.node(from, from + $head.parent.nodeSize, { class: 'active-block' }),
            ])
          },
        },
      }),
    ]
  },
})
