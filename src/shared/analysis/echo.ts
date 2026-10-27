/**
 * Echoes: the same content word (simple forms counted together) used again
 * within a short distance. Each echoing word gets a colour group, and nearby
 * repeats are grouped into clusters so they can be stepped through.
 */
import { isContentWord, type AnalysisWordOptions } from './stats'
import { stem } from './stem'
import type { Token } from './tokens'

export interface EchoResult {
  /** For each echoing token (index into the input), its word key and colour group. */
  marks: Map<number, { stem: string; group: number }>
  /** Runs of nearby repeats of one word: token indexes in order. */
  clusters: number[][]
}

export const ECHO_COLORS = 8

/** `tokens` must be in reading order; `range` is the distance in words. */
export function findEchoes(
  tokens: Token[],
  options: AnalysisWordOptions,
  range: number,
): EchoResult {
  const positions = new Map<string, number[]>()
  tokens.forEach((t, i) => {
    if (!isContentWord(t, options)) return
    const key = stem(t.lower)
    const list = positions.get(key) ?? []
    list.push(i)
    positions.set(key, list)
  })

  const marks: EchoResult['marks'] = new Map()
  const clusters: number[][] = []
  const groups = new Map<string, number>()
  // Colour groups go in order of first echo, so colours stay stable while typing further on.
  const found: { key: string; cluster: number[] }[] = []
  for (const [key, list] of positions) {
    let cluster: number[] = [list[0]!]
    for (let n = 1; n <= list.length; n++) {
      const i = list[n]
      if (i !== undefined && i - cluster[cluster.length - 1]! <= range) {
        cluster.push(i)
        continue
      }
      if (cluster.length > 1) found.push({ key, cluster })
      if (i !== undefined) cluster = [i]
    }
  }
  found.sort((a, b) => a.cluster[0]! - b.cluster[0]!)
  for (const { key, cluster } of found) {
    if (!groups.has(key)) groups.set(key, groups.size % ECHO_COLORS)
    const group = groups.get(key)!
    for (const i of cluster) marks.set(i, { stem: key, group })
    clusters.push(cluster)
  }
  return { marks, clusters }
}
