/**
 * Find a scene by describing it ("the bit where Josh lies to Sara about the
 * van"). Two small steps: pick the likely chapters from their summaries and
 * the passages that mention the right words, then find the paragraph in each.
 */

export interface SceneCandidate {
  /** Short reference the model answers with: "C12". */
  ref: string
  label: string
  title: string
  summary: string | null
  /** Passages from this chapter that mention the description's words. */
  passages: string[]
}

export interface SceneMatch {
  ref: string
  why: string
}

/** How many chapters are checked closely, at most. */
export const MAX_SCENE_MATCHES = 3

export function pickChaptersPrompt(
  description: string,
  candidates: readonly SceneCandidate[],
): { system: string; user: string } {
  const lines = candidates.map((c) => {
    const head = `[${c.ref}] ${c.label} “${c.title || 'Untitled'}”`
    const summary = c.summary ? `: ${c.summary}` : ' (no summary yet)'
    const passages = c.passages.map((p) => `\n    – ${p}`).join('')
    return `${head}${summary}${passages}`
  })
  return {
    system: `The writer is looking for a scene in their own novel and describes it in their own words. From the chapters below (each with its summary and, sometimes, passages that mention the same words), pick the chapters most likely to hold that scene, best first, at most ${MAX_SCENE_MATCHES}. Judge by what happens, not by shared words. For each, say in a few words why it fits. If nothing fits, return no matches.
Reply with JSON only: {"matches": [{"chapter": "C12", "why": "..."}]}`,
    user: `The scene: ${description}\n\nChapters:\n${lines.join('\n')}`,
  }
}

export function parseChapterMatches(reply: string, refs: ReadonlySet<string>): SceneMatch[] {
  const data = firstJson(reply) as { matches?: unknown } | null
  if (!data || !Array.isArray(data.matches)) return []
  const out: SceneMatch[] = []
  for (const m of data.matches) {
    if (!m || typeof m !== 'object') continue
    const ref = String((m as { chapter?: unknown }).chapter ?? '')
      .trim()
      .replace(/^\[|\]$/g, '')
      .toUpperCase()
    if (!refs.has(ref) || out.some((o) => o.ref === ref)) continue
    out.push({
      ref,
      why: String((m as { why?: unknown }).why ?? '')
        .trim()
        .slice(0, 300),
    })
    if (out.length >= MAX_SCENE_MATCHES) break
  }
  return out
}

/** Paragraphs sent when looking inside one chapter (numbered from 1). */
export const MAX_SCENE_WORDS = 6000

export function findParagraphPrompt(
  description: string,
  chapterName: string,
  paragraphs: readonly string[],
): { system: string; user: string; shown: number } {
  const lines: string[] = []
  let words = 0
  for (const [i, p] of paragraphs.entries()) {
    words += p.split(/\s+/).filter(Boolean).length
    if (words > MAX_SCENE_WORDS && lines.length) break
    lines.push(`[${i + 1}] ${p}`)
  }
  return {
    system: `The writer is looking for a scene in this chapter of their own novel. Find the paragraph where it starts (or where the moment they describe happens). Reply with JSON only: {"paragraph": 12, "why": "a few words"}, or {"paragraph": null} if it isn't in this chapter.`,
    user: `The scene: ${description}\n\n${chapterName}:\n${lines.join('\n')}`,
    shown: lines.length,
  }
}

export function parseParagraph(
  reply: string,
  shown: number,
): { paragraph: number; why: string } | null {
  const data = firstJson(reply) as { paragraph?: unknown; why?: unknown } | null
  const n = Number(data?.paragraph)
  if (!data || !Number.isInteger(n) || n < 1 || n > shown) return null
  return {
    paragraph: n - 1,
    why: String(data.why ?? '')
      .trim()
      .slice(0, 300),
  }
}

/** Words from the start of a paragraph to find it on the page with Find. */
export function paragraphProbe(paragraph: string, words = 6): string {
  return paragraph.trim().split(/\s+/).slice(0, words).join(' ')
}

function firstJson(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
}
