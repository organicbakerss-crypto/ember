/**
 * Page view: the chapter is laid out on separate sheets. The plugin measures
 * where each line falls and inserts view-only spacers so a line that would
 * cross the bottom of a page starts at the top of the next. The spacers are
 * decorations: never part of the document, never saved.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { PageGeometry } from './pageBreaks'

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
          // The first position changed since the last layout (null with `full`: everything).
          let dirty: number | null = null
          let full = true
          // Some edit since the last layout joined, split, added or removed blocks.
          let structural = false
          let running: Job = { cancelled: true, done: true, from: null }
          const schedule = (delay: number) => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (view.isDestroyed) return
              // A layout still going is taken over: the new one covers what it hadn't done.
              if (!running.done) {
                running.cancelled = true
                if (running.from === null) full = true
                else dirty = dirty === null ? running.from : Math.min(dirty, running.from)
              }
              const from = full ? null : dirty
              const quick = !structural
              full = false
              dirty = null
              structural = false
              running = { cancelled: false, done: false, from }
              layOut(view, storage, from, quick, running, () => {
                structural = true
                schedule(0)
              })
            }, delay)
          }
          // Re-lay out when the page width really changes, and once if fonts arrive late.
          let width = view.dom.clientWidth
          const resize = new ResizeObserver(() => {
            if (view.dom.clientWidth === width) return
            width = view.dom.clientWidth
            full = true
            schedule(LAYOUT_DELAY_MS)
          })
          resize.observe(view.dom)
          if (document.fonts && document.fonts.status !== 'loaded') {
            void document.fonts.ready.then(() => {
              full = true
              schedule(0)
            })
          }
          schedule(0)
          return {
            update(v, prev) {
              if (key.getState(v.state)?.stale) {
                full = true
                schedule(0)
              } else if (v.state.doc !== prev.doc) {
                const at = prev.doc.content.findDiffStart(v.state.doc.content) ?? 0
                dirty = dirty === null ? at : Math.min(dirty, at)
                // An edit that stays inside one text block can only move what follows if
                // that block's height changes; anything else (joins, splits) always can.
                const end = prev.doc.content.findDiffEnd(v.state.doc.content)
                const inside = (doc: typeof prev.doc, a: number, b: number) => {
                  const $a = doc.resolve(Math.min(a, doc.content.size))
                  const $b = doc.resolve(Math.min(Math.max(a, b), doc.content.size))
                  return $a.parent.isTextblock && $a.sameParent($b)
                }
                if (!end || !inside(prev.doc, at, end.a) || !inside(v.state.doc, at, end.b)) {
                  structural = true
                }
                schedule(LAYOUT_DELAY_MS)
              }
            },
            destroy() {
              clearTimeout(timer)
              running.cancelled = true
              resize.disconnect()
            },
          }
        },
      }),
    ]
  },
})

interface Job {
  cancelled: boolean
  /** Finished (or nothing to do). */
  done: boolean
  /** Where it started (null: everything). */
  from: number | null
}

interface Break {
  pos: number
  space: number
}

/** Heights of text blocks at the last layout: a block that kept its height moves nothing after it. */
const heights = new WeakMap<Element, number>()

/** Work slices: never hold the screen longer than this. */
const SLICE_MS = 12

/**
 * Lays out page breaks from `from` (a changed position; null for the whole
 * text). Pages before the changed block are kept. Blocks are measured whole;
 * only a block that crosses the bottom of a page has its lines measured. The
 * work is done in short slices, so clicks and keys get through, and the
 * pages on screen are put right first.
 */
function layOut(
  view: EditorView,
  storage: PaginationStorage,
  from: number | null,
  /** The edits stayed inside single text blocks (a same-height block moves nothing). */
  quick: boolean,
  job: Job,
  again: () => void,
): void {
  const { layout } = storage
  const state = key.getState(view.state)
  const existing = (state?.decorations.find() ?? [])
    .map((d) => ({ pos: d.from, space: (d.spec as { space?: number }).space ?? 0 }))
    .sort((a, b) => a.pos - b.pos)
  if (!layout.enabled || layout.contentHeight <= 0) {
    if (existing.length) view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty))
    storage.onPages?.(1)
    job.done = true
    return
  }
  const doc = view.state.doc
  // Where to start: the text block holding the first change.
  let start = 0
  if (from !== null) {
    const $at = doc.resolve(Math.min(from, doc.content.size))
    let depth = $at.depth
    while (depth > 0 && !$at.node(depth).isTextblock) depth--
    start = depth > 0 ? $at.before(depth) : $at.pos
    // Typing that didn't change the block's height and has no page edge inside it moves nothing.
    const node = depth > 0 ? $at.node(depth) : null
    const dom = node ? view.nodeDOM(start) : null
    if (
      quick &&
      node &&
      dom instanceof HTMLElement &&
      heights.get(dom) === dom.offsetHeight &&
      !existing.some((b) => b.pos > start + 1 && b.pos < start + node.nodeSize)
    ) {
      job.done = true
      return
    }
  }
  const keep = existing.filter((b) => b.pos < start)
  const scroller = view.dom.closest('.page-scroll')
  /**
   * Puts the breaks in. First the editor takes in anything the writer just did
   * on screen (an arrow key, a click) that it hasn't read yet, so redrawing the
   * page can't undo it; if that changed the text, the breaks are out of date
   * and nothing is applied (returns false).
   */
  const apply = (breaks: Break[]): boolean => {
    ;(view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
    if (view.state.doc !== doc) return false
    const top = scroller?.scrollTop ?? 0
    view.dispatch(
      view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, breaks.map(widget))),
    )
    if (scroller) scroller.scrollTop = top
    return true
  }
  const restart = () => {
    job.done = false
    again()
  }
  // Take out the spacers from the changed block on; measure from there.
  if (keep.length !== existing.length && !apply(keep)) {
    restart()
    return
  }

  const { contentHeight, pitch } = layout
  const origin = textAreaTop(view)
  const viewBottom = (scroller?.getBoundingClientRect().bottom ?? window.innerHeight) - origin
  const blocks = collectBlocks(view, start)
  const found: Break[] = []
  let shift = 0 // space added in this pass (not in the page yet)
  let page = 0
  let i = 0
  let first = true
  let shownApplied = false
  let lastBottom = 0

  /** One line (or a whole block) at `top…bottom`; returns a break before it, if one is needed. */
  const place = (top: number, bottom: number, forced: boolean): number | null => {
    if (first) {
      page = Math.max(0, Math.floor(top / pitch))
      first = false
    }
    const t = top + shift
    const b = bottom + shift
    if (t >= page * pitch + contentHeight) page = Math.max(page, Math.floor(t / pitch))
    const pageEnd = page * pitch + contentHeight
    const overflows = b > pageEnd + 0.5
    if ((forced || overflows) && t > page * pitch + 0.5) {
      const space = (page + 1) * pitch - t
      shift += space
      page++
      return space
    }
    return null
  }

  const step = () => {
    if (job.cancelled || view.isDestroyed) return
    if (view.state.doc !== doc) {
      // Changed while being laid out: the next run starts from here at the latest.
      restart()
      return
    }
    const until = performance.now() + SLICE_MS
    while (i < blocks.length && performance.now() < until) {
      const blk = blocks[i++]!
      const r = blk.dom.getBoundingClientRect()
      const top = blk.headTop !== undefined ? blk.headTop(r) - origin : r.top - origin
      const bottom = r.bottom - origin
      if (blk.startsPage) {
        const head = blk.dom.firstElementChild?.getBoundingClientRect()
        const space = place(top, (head?.bottom ?? r.top) - origin, true)
        if (space !== null) found.push({ pos: blk.pos, space })
        continue
      }
      heights.set(blk.dom, blk.dom.offsetHeight)
      lastBottom = bottom
      const t = top + shift
      const pageEnd = page * pitch + contentHeight
      if (!first && bottom + shift <= pageEnd + 0.5 && t < pageEnd) continue
      if (blk.atom || !blk.text) {
        const space = place(top, bottom, false)
        if (space !== null) found.push({ pos: blk.atom ? blk.pos : blk.pos + 1, space })
        continue
      }
      // It crosses a page edge: measure its lines.
      const lines = blockLines(blk.dom)
      lines.forEach((line, n) => {
        const space = place(line.top - origin, line.bottom - origin, false)
        if (space === null) return
        let pos = blk.pos + 1
        if (n > 0) {
          const hit = view.posAtCoords({ left: line.left + 1, top: (line.top + line.bottom) / 2 })
          if (!hit) return
          pos = hit.pos
        }
        found.push({ pos, space })
      })
    }
    // The pages on screen first.
    if (!shownApplied && (i >= blocks.length || lastBottom + shift > viewBottom + pitch)) {
      shownApplied = true
      if (found.length && i < blocks.length) {
        if (!apply([...keep, ...found])) {
          restart()
          return
        }
        keep.push(...found)
        found.length = 0
        shift = 0
      }
    }
    if (i < blocks.length) {
      setTimeout(step, 0)
      return
    }
    if (!apply([...keep, ...found])) {
      restart()
      return
    }
    job.done = true
    const end = lastBottom + shift
    storage.onPages?.(Math.max(1, Math.floor(Math.max(0, end - 0.5) / pitch) + 1))
  }
  step()
}

interface Block {
  pos: number
  dom: HTMLElement
  atom: boolean
  text: boolean
  startsPage: boolean
  headTop?: (r: DOMRect) => number
}

/** Text blocks (and atoms, and blocks that start a page) from `start` on, in order. */
function collectBlocks(view: EditorView, start: number): Block[] {
  const out: Block[] = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock && !node.isAtom) {
      if (pos >= start) {
        const dom = view.nodeDOM(pos)
        if (dom instanceof HTMLElement && dom.dataset['startsPage'] !== undefined) {
          out.push({ pos, dom, atom: false, text: false, startsPage: true })
        }
      }
      return true
    }
    if (pos + node.nodeSize <= start) return false
    const dom = view.nodeDOM(pos)
    if (dom instanceof HTMLElement) {
      out.push({
        pos,
        dom,
        atom: node.isAtom,
        text: node.isTextblock && node.content.size > 0,
        startsPage: false,
      })
    }
    return false
  })
  return out
}

/** A block's lines of text (its inline boxes grouped by line). */
function blockLines(dom: HTMLElement): { top: number; bottom: number; left: number }[] {
  const range = document.createRange()
  range.selectNodeContents(dom)
  return groupIntoLines([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0))
}

function widget({ pos, space }: Break): Decoration {
  return Decoration.widget(pos, () => spacer(space), {
    side: -1,
    key: `page-break-${Math.round(space)}`,
    ignoreSelection: true,
    space,
  })
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
