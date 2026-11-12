/**
 * A picture in a chapter. The chapter keeps only the picture's file name
 * (stored once in the book's images folder, named by its content) and a short
 * description; the page shows it from the book's folder. Exports embed it.
 */
import { Node } from '@tiptap/core'
import { chapterImageUrl } from '@shared/media'

export interface ChapterImageOptions {
  /** The book the chapter is in (where its pictures are); null shows the description only. */
  seriesId: string | null
  volumeId: string | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    chapterImage: {
      /** Puts a picture in at the cursor (one undoable step). */
      insertChapterImage: (file: string, alt?: string) => ReturnType
    }
  }
}

export const ChapterImage = Node.create<ChapterImageOptions>({
  name: 'chapterImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { seriesId: null, volumeId: null }
  },

  addAttributes() {
    return {
      file: { default: null },
      alt: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-chapter-image]',
        getAttrs: (el) => ({
          file: (el as HTMLElement).dataset['chapterImage'] ?? null,
          alt: (el as HTMLElement).querySelector('img')?.getAttribute('alt') ?? '',
        }),
      },
    ]
  },

  renderHTML({ node }) {
    return [
      'figure',
      { 'data-chapter-image': node.attrs['file'] as string, class: 'chapter-image' },
      ['img', { alt: node.attrs['alt'] as string }],
    ]
  },

  addNodeView() {
    const { seriesId, volumeId } = this.options
    return ({ node }) => {
      const dom = document.createElement('figure')
      dom.className = 'chapter-image'
      dom.contentEditable = 'false'
      const file = node.attrs['file'] as string | null
      const alt = (node.attrs['alt'] as string) || 'Picture'
      if (seriesId && volumeId && file) {
        const img = document.createElement('img')
        img.src = chapterImageUrl(seriesId, volumeId, file)
        img.alt = alt
        img.draggable = false
        img.onerror = () => {
          img.replaceWith(
            Object.assign(document.createElement('span'), { textContent: `[${alt}]` }),
          )
        }
        dom.append(img)
      } else {
        dom.append(Object.assign(document.createElement('span'), { textContent: `[${alt}]` }))
      }
      return { dom }
    }
  },

  addCommands() {
    return {
      insertChapterImage:
        (file, alt = '') =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { file, alt } }),
    }
  },
})
