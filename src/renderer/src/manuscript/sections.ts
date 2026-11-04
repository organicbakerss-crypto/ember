/**
 * The Manuscript view's document: the whole book in one editor, each chapter
 * its own section. Chapter boundaries are locked: a guard refuses any change
 * that would add, remove, merge or reorder chapters (joining or splitting is
 * done with the split/merge commands), or that touches a chapter edited
 * somewhere else. Sections are "isolating", so Backspace at a chapter's start
 * stops there instead of reaching into the one before.
 */
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const ManuscriptDocument = Document.extend({ content: 'chapterSection+' })

export const ChapterSection = Node.create({
  name: 'chapterSection',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      chapterId: { default: null },
      /** Its heading as a book shows it ("Chapter 1: Arrival"); drawn, not typed. */
      heading: { default: '' },
    }
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'section',
      mergeAttributes(HTMLAttributes, {
        class: 'ms-chapter',
        'data-chapter': node.attrs['chapterId'] as string,
        'data-heading': node.attrs['heading'] as string,
      }),
      0,
    ]
  },
  parseHTML() {
    return [{ tag: 'section.ms-chapter' }]
  },
})

/** Chapter ids in order, from the document's top level. */
export function sectionIds(doc: PMNode): string[] {
  const ids: string[] = []
  doc.forEach((n) => {
    if (n.type.name === 'chapterSection') ids.push(String(n.attrs['chapterId']))
  })
  return ids
}

/** Each chapter's section, by id. */
export function sectionsById(doc: PMNode): Map<string, PMNode> {
  const out = new Map<string, PMNode>()
  doc.forEach((n) => {
    if (n.type.name === 'chapterSection') out.set(String(n.attrs['chapterId']), n)
  })
  return out
}

/** Marks a change the app makes itself (loading a chapter saved elsewhere): let through. */
export const INTERNAL = 'manuscript-internal'

export const guardKey = new PluginKey('manuscriptGuard')

/**
 * Locks chapter boundaries and read-only chapters. `readOnly` says which
 * chapters are being edited somewhere else right now.
 */
export function guardPlugin(readOnly: () => ReadonlySet<string>): Plugin {
  return new Plugin({
    key: guardKey,
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(INTERNAL)) return true
      const before = sectionIds(state.doc)
      const after = sectionIds(tr.doc)
      if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
        return false
      }
      const locked = readOnly()
      if (!locked.size) return true
      const old = sectionsById(state.doc)
      for (const [id, node] of sectionsById(tr.doc)) {
        if (locked.has(id) && !node.content.eq(old.get(id)!.content)) return false
      }
      return true
    },
    props: {
      // Chapters edited elsewhere look read-only.
      decorations(state) {
        const locked = readOnly()
        if (!locked.size) return null
        const decos: Decoration[] = []
        state.doc.forEach((n, offset) => {
          if (locked.has(String(n.attrs['chapterId']))) {
            decos.push(
              Decoration.node(offset, offset + n.nodeSize, {
                class: 'ms-readonly',
                title: 'Being edited in another window or pane',
              }),
            )
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

export function SectionGuard(readOnly: () => ReadonlySet<string>) {
  return Extension.create({
    name: 'manuscriptGuard',
    addProseMirrorPlugins: () => [guardPlugin(readOnly)],
  })
}
