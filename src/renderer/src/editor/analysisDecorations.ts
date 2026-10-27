/**
 * Rhythm, Echo and word highlights: view-only decorations. They are drawn
 * over the text but never become part of the document, so they are never
 * saved, exported or synced. They are recalculated a moment after typing
 * stops; in between, the previous highlights just move with the text.
 */
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  findEchoes,
  isContentWord,
  splitSentences,
  stem,
  tokenize,
  type AnalysisWordOptions,
  type Token,
} from '@shared/analysis'

export const RECALC_DELAY_MS = 500

export interface AnalysisOptions {
  rhythm: boolean
  echo: boolean
  /** Highlight every use of this word (stem), from Diagnostics. */
  highlightStem: string | null
  words: AnalysisWordOptions
  echoRange: number
  rhythmMediumFrom: number
  rhythmLongFrom: number
}

/** A run of nearby repeats the writer clicked, to step through. */
export interface ActiveEcho {
  word: string
  ranges: { from: number; to: number }[]
  /** Which of `ranges` was clicked. */
  index: number
}

interface PluginState {
  decorations: DecorationSet
  /** Set when options change, so the view recalculates straight away. */
  stale: boolean
}

interface AnalysisStorage {
  options: AnalysisOptions
  clusters: { word: string; ranges: { from: number; to: number }[] }[]
  activeCluster: number | null
  onActiveEcho: ((echo: ActiveEcho | null) => void) | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    analysisDecorations: {
      setAnalysis: (options: AnalysisOptions) => ReturnType
      /** Who to tell when the writer clicks (or leaves) a run of echoes. */
      onActiveEcho: (listener: ((echo: ActiveEcho | null) => void) | null) => ReturnType
      clearActiveEcho: () => ReturnType
    }
  }
  interface Storage {
    analysisDecorations: AnalysisStorage
  }
}

const key = new PluginKey<PluginState>('analysisDecorations')

export const AnalysisDecorations = Extension.create<object, AnalysisStorage>({
  name: 'analysisDecorations',

  addStorage() {
    return {
      options: {
        rhythm: false,
        echo: false,
        highlightStem: null,
        words: { fillers: new Set(), names: new Set(), includeNames: false },
        echoRange: 50,
        rhythmMediumFrom: 10,
        rhythmLongFrom: 20,
      },
      clusters: [],
      activeCluster: null,
      onActiveEcho: null,
    }
  },

  addCommands() {
    return {
      setAnalysis:
        (options) =>
        ({ tr }) => {
          this.storage.options = options
          if (!options.echo) this.storage.activeCluster = null
          tr.setMeta(key, 'stale')
          return true
        },
      onActiveEcho: (listener) => () => {
        this.storage.onActiveEcho = listener
        return true
      },
      clearActiveEcho:
        () =>
        ({ tr }) => {
          this.storage.activeCluster = null
          this.storage.onActiveEcho?.(null)
          tr.setMeta(key, 'stale')
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    // After a recalculation the clicked run of repeats may have moved; report it afresh.
    const notifyActive = () => {
      const i = storage.activeCluster
      const cluster = i === null ? undefined : storage.clusters[i]
      storage.onActiveEcho?.(
        cluster ? { word: cluster.word, ranges: cluster.ranges, index: 0 } : null,
      )
    }

    return [
      new Plugin<PluginState>({
        key,
        state: {
          init: () => ({ decorations: DecorationSet.empty, stale: true }),
          apply(tr, value) {
            const meta = tr.getMeta(key) as DecorationSet | 'stale' | undefined
            if (meta instanceof DecorationSet) return { decorations: meta, stale: false }
            const decorations = value.decorations.map(tr.mapping, tr.doc)
            return { decorations, stale: value.stale || meta === 'stale' }
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          handleClick(view, pos) {
            if (!storage.options.echo) return false
            const index = storage.clusters.findIndex((c) =>
              c.ranges.some((r) => pos >= r.from && pos <= r.to),
            )
            const next = index < 0 ? null : index
            if (next === storage.activeCluster) return false
            storage.activeCluster = next
            recalculate(view, storage)
            if (next === null) storage.onActiveEcho?.(null)
            else {
              const cluster = storage.clusters[next]!
              const clicked = cluster.ranges.findIndex((r) => pos >= r.from && pos <= r.to)
              storage.onActiveEcho?.({ word: cluster.word, ranges: cluster.ranges, index: clicked })
            }
            return false
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const schedule = (delay: number) => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (view.isDestroyed) return
              recalculate(view, storage)
              if (storage.activeCluster !== null) notifyActive()
            }, delay)
          }
          schedule(0)
          return {
            update(v, prev) {
              if (key.getState(v.state)?.stale) schedule(0)
              else if (v.state.doc !== prev.doc) schedule(RECALC_DELAY_MS)
            },
            destroy() {
              clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})

function recalculate(view: EditorView, storage: AnalysisStorage): void {
  const { decorations, clusters } = buildDecorations(
    view.state.doc,
    storage.options,
    storage.activeCluster,
  )
  storage.clusters = clusters
  if (storage.activeCluster !== null && storage.activeCluster >= clusters.length)
    storage.activeCluster = null
  view.dispatch(view.state.tr.setMeta(key, decorations))
}

interface Block {
  text: string
  /** Document position of each character of `text`. */
  positions: number[]
}

/** Text of each textblock, with a map back to document positions. */
function textBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const block: Block = { text: '', positions: [] }
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        block.text += child.text
        for (let i = 0; i < child.text!.length; i++) block.positions.push(start + i)
      } else {
        // Line breaks end sentences; other inline nodes are a space.
        block.text += child.type.name === 'hardBreak' ? '\n' : ' '
        block.positions.push(start)
      }
    })
    blocks.push(block)
    return false
  })
  return blocks
}

export function buildDecorations(
  doc: PMNode,
  options: AnalysisOptions,
  activeCluster: number | null,
): { decorations: DecorationSet; clusters: AnalysisStorage['clusters'] } {
  const decorations: Decoration[] = []
  const clusters: AnalysisStorage['clusters'] = []
  if (!options.rhythm && !options.echo && !options.highlightStem) {
    return { decorations: DecorationSet.empty, clusters }
  }
  const blocks = textBlocks(doc)
  const range = (block: Block, start: number, end: number) => ({
    from: block.positions[start]!,
    to: block.positions[end - 1]! + 1,
  })

  const allTokens: Token[] = []
  for (const block of blocks) {
    const tokens = tokenize(block.text)
    for (const t of tokens) {
      const r = range(block, t.start, t.end)
      allTokens.push({ ...t, start: r.from, end: r.to })
    }
    if (options.rhythm) {
      for (const s of splitSentences(block.text)) {
        const words = tokens.filter((t) => t.start >= s.start && t.start < s.end).length
        if (!words) continue
        const band =
          words >= options.rhythmLongFrom
            ? 'long'
            : words >= options.rhythmMediumFrom
              ? 'medium'
              : 'short'
        const r = range(block, s.start, s.end)
        decorations.push(
          Decoration.inline(r.from, r.to, {
            class: `rhythm rhythm-${band}`,
            title: `${words} ${words === 1 ? 'word' : 'words'}`,
          }),
        )
      }
    }
  }

  if (options.echo) {
    const result = findEchoes(allTokens, options.words, options.echoRange)
    result.clusters.forEach((cluster, index) => {
      const first = allTokens[cluster[0]!]!
      clusters.push({
        word: first.lower,
        ranges: cluster.map((i) => ({ from: allTokens[i]!.start, to: allTokens[i]!.end })),
      })
      for (const i of cluster) {
        const t = allTokens[i]!
        const mark = result.marks.get(i)!
        decorations.push(
          Decoration.inline(t.start, t.end, {
            class: `echo echo-${mark.group}${index === activeCluster ? ' echo-active' : ''}`,
            title: `“${t.text}” repeats nearby`,
          }),
        )
      }
    })
  }

  if (options.highlightStem) {
    for (const t of allTokens) {
      if (
        isContentWord(t, { ...options.words, includeNames: true }) &&
        stem(t.lower) === options.highlightStem
      ) {
        decorations.push(Decoration.inline(t.start, t.end, { class: 'word-highlight' }))
      }
    }
  }

  return { decorations: DecorationSet.create(doc, decorations), clusters }
}
