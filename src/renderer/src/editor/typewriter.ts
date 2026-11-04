/**
 * Typewriter scrolling: while typing (or moving with the keyboard), the line
 * with the cursor is kept in the middle of the page area. Clicking somewhere
 * doesn't move the page.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    typewriter: { setTypewriter: (on: boolean) => ReturnType }
  }
}

const key = new PluginKey<{ pointer: boolean }>('typewriter')

export const Typewriter = Extension.create<object, { on: boolean }>({
  name: 'typewriter',
  addStorage: () => ({ on: false }),
  addCommands() {
    return {
      setTypewriter:
        (on) =>
        ({ tr }) => {
          this.storage.on = on
          tr.setMeta(key, 'changed')
          return true
        },
    }
  },
  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin({
        key,
        state: {
          init: () => ({ pointer: false }),
          // A selection made with the mouse leaves the page where it is.
          apply: (tr) => ({ pointer: !!tr.getMeta('pointer') }),
        },
        view: () => ({
          update(view, prev) {
            if (!storage.on || !view.hasFocus()) return
            if (view.state.doc === prev.doc && view.state.selection.eq(prev.selection)) return
            if (key.getState(view.state)?.pointer) return
            const scroller = view.dom.closest('.page-scroll')
            if (!scroller) return
            const at = view.coordsAtPos(view.state.selection.head)
            const box = scroller.getBoundingClientRect()
            scroller.scrollTop += (at.top + at.bottom) / 2 - (box.top + box.height / 2)
          },
        }),
      }),
    ]
  },
})
