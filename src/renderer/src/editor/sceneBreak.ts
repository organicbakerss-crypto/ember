import { mergeAttributes, Node, nodeInputRule } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sceneBreak: {
      /** Inserts a scene break at the cursor. */
      insertSceneBreak: () => ReturnType
    }
  }
}

/**
 * A scene break inside a chapter. Stored as `{ "type": "sceneBreak" }` and
 * shown as a centred divider; the binder lists scenes as jump points.
 * Typing `***` or `---` on an empty line inserts one.
 */
export const SceneBreak = Node.create({
  name: 'sceneBreak',
  group: 'block',
  atom: true,
  selectable: true,
  renderText: () => '\n',

  parseHTML() {
    return [{ tag: 'hr' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['hr', mergeAttributes(HTMLAttributes, { 'data-scene-break': '' })]
  },

  addCommands() {
    return {
      insertSceneBreak:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name }, { type: 'paragraph' }])
            .run(),
    }
  },

  addInputRules() {
    return [nodeInputRule({ find: /^(?:\*\*\*|---)\s$/, type: this.type })]
  },
})
