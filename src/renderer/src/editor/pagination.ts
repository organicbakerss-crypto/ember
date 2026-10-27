/**
 * Page view: the chapter is laid out on separate sheets. The plugin measures
 * where each line falls and inserts view-only spacers so a line that would
 * cross the bottom of a page starts at the top of the next. The spacers are
 * decorations: never part of the document, never saved.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { planPageBreaks, type Line, type PageGeometry } from './pageBreaks'

export const LAYOUT_DELAY_MS = 300

export interface PageLayout extends PageGeometry {
  enabled: boolean
}

interface PaginationStorage {
  layout: PageLayout
  onPages: ((pages: number) => void) | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pagination: {
      setPageLayout: (layout: PageLayout) => ReturnType
      onPages: (listener: ((pages: number) => void) | null) => ReturnType
    }
  }
  interface Storage {
    pagination: PaginationStorage
  }
}

const key = new PluginKey<{ decorations: DecorationSet; stale: boolean }>('pagination')

export const Pagination = Extension.create<object, PaginationStorage>({
  name: 'pagination',

  addStorage() {
    return { layout: { enabled: false, contentHeight: 0, pitch: 0 }, onPages: null }
  },

  addCommands() {
    return {
      setPageLayout:
        (layout) =>
        ({ tr }) => {
          this.storage.layout = layout
          tr.setMeta(key, 'stale')
          return true
        },
      onPages: (listener) => () => {
        this.storage.onPages = listener
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
        props: { decorations: (state) => key.getState(state)?.decorations },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const schedule = (delay: number) => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (!view.isDestroyed) layOut(view, storage)
            }, delay)
          }
          // Re-lay out when the page width changes (window resize, settings) and once fonts load.
          const resize = new ResizeObserver(() => schedule(LAYOUT_DELAY_MS))
          resize.observe(view.dom)
          void document.fonts?.ready.then(() => schedule(0))
          schedule(0)
          return {
            update(v, prev) {
              if (key.getState(v.state)?.stale) schedule(0)
              else if (v.state.doc !== prev.doc) schedule(LAYOUT_DELAY_MS)
            },
            destroy() {
              clearTimeout(timer)
              resize.disconnect()
            },
          }
        },
      }),
    ]
  },
})

function layOut(view: EditorView, storage: PaginationStorage): void {
  const { layout } = storage
  const scroller = view.dom.closest('.page-scroll')
  const scrollTop = scroller?.scrollTop ?? 0

  // Measure the text as one long sheet: take the spacers out, measure, put new ones in.
  // All of this happens before the browser paints, so nothing flickers.
  view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty))
  if (!layout.enabled || layout.contentHeight <= 0) {
    storage.onPages?.(1)
    return
  }
  const origin = textAreaTop(view)
  const measured = measureLines(view, origin)
  const { breaks, pages } = planPageBreaks(
    measured.map((m) => m.line),
    layout,
  )
  const decorations = breaks.map(({ line, space }) => {
    const { pos } = measured[line]!
    return Decoration.widget(pos, () => spacer(space), {
      side: -1,
      key: `page-break-${Math.round(space)}`,
      ignoreSelection: true,
    })
  })
  view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, decorations)))
  if (scroller) scroller.scrollTop = scrollTop
  storage.onPages?.(pages)
}

function spacer(height: number): HTMLElement {
  const el = document.createElement('span')
  el.className = 'page-break-space'
  el.style.height = `${height}px`
  el.contentEditable = 'false'
  el.setAttribute('aria-hidden', 'true')
  return el
}

/** Top of the first page's text area, in viewport coordinates. */
function textAreaTop(view: EditorView): number {
  const page = view.dom.closest<HTMLElement>('.page-content')
  if (!page) return view.dom.getBoundingClientRect().top
  return page.getBoundingClientRect().top + parseFloat(getComputedStyle(page).paddingTop)
}

/**
 * Every line of text (and every block without text, like a scene break),
 * with the document position a page break would go before it.
 */
function measureLines(view: EditorView, origin: number): { line: Line; pos: number }[] {
  const out: { line: Line; pos: number }[] = []
  const range = document.createRange()
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock && !node.isAtom) return true
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return false
    if (node.isAtom || node.content.size === 0) {
      const r = dom.getBoundingClientRect()
      out.push({
        line: { top: r.top - origin, bottom: r.bottom - origin },
        pos: node.isAtom ? pos : pos + 1,
      })
      return false
    }
    range.selectNodeContents(dom)
    const lines = groupIntoLines(
      [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0),
    )
    lines.forEach((line, i) => {
      let at = pos + 1
      if (i > 0) {
        const hit = view.posAtCoords({ left: line.left + 1, top: (line.top + line.bottom) / 2 })
        if (!hit) return
        at = hit.pos
      }
      out.push({ line: { top: line.top - origin, bottom: line.bottom - origin }, pos: at })
    })
    return false
  })
  return out
}

/** Merges the rectangles of inline boxes into lines of text. */
function groupIntoLines(rects: DOMRect[]): { top: number; bottom: number; left: number }[] {
  const lines: { top: number; bottom: number; left: number }[] = []
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = lines[lines.length - 1]
    const overlap = last ? Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top) : 0
    if (last && overlap > Math.min(r.height, last.bottom - last.top) / 2) {
      last.top = Math.min(last.top, r.top)
      last.bottom = Math.max(last.bottom, r.bottom)
      last.left = Math.min(last.left, r.left)
    } else {
      lines.push({ top: r.top, bottom: r.bottom, left: r.left })
    }
  }
  return lines
}
