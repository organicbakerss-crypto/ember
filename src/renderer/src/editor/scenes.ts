import type { Node as PMNode } from '@tiptap/pm/model'
import { countWords } from '@shared/text'

export interface Scene {
  /** Position of the scene break that starts the scene (0 for the first scene). */
  pos: number
  /** The first few words, as a label. */
  label: string
}

const LABEL_WORDS = 6

/** Splits a chapter into scenes at its scene breaks. */
export function findScenes(doc: PMNode): Scene[] {
  const scenes: Scene[] = [{ pos: 0, label: '' }]
  doc.forEach((node, offset) => {
    const current = scenes[scenes.length - 1]!
    if (node.type.name === 'sceneBreak') {
      scenes.push({ pos: offset, label: '' })
    } else if (!current.label && node.textContent.trim()) {
      current.label = firstWords(node.textContent)
    }
  })
  return scenes
}

function firstWords(text: string): string {
  const words = text.trim().split(/\s+/)
  const head = words.slice(0, LABEL_WORDS).join(' ')
  return words.length > LABEL_WORDS ? `${head}…` : head
}

/** Word count straight from the editor's document (cheap enough to run on every change). */
export function docWords(doc: PMNode): number {
  return countWords(doc.textBetween(0, doc.content.size, '\n', '\n'))
}
