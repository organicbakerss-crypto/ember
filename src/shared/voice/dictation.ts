/**
 * Tidying what was dictated: "quote … end quote" becomes quote marks, and a
 * near-miss of one of the world's names ("Bran Ock") becomes the name
 * (Brannoch). Only capitalised words are taken for names, so ordinary words
 * are left alone.
 */

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return d[a.length]![b.length]!
}

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function cleanDictation(text: string, names: string[]): string {
  let t = text
    .replace(/[,.]?\s*\b(?:end quote|close quote|unquote)\b/gi, '”')
    .replace(/\s*\b(?:open quote|quote)\b[,.]?\s*/gi, ' “')
    .replace(/\s+/g, ' ')
    .trim()
  const known = names
    .map((n) => n.trim())
    .filter((n) => n.length >= 4 && !n.includes(' '))
    .map((n) => ({ name: n, key: plain(n) }))
  if (!known.length) return t
  const close = (word: string) => {
    const k = plain(word)
    if (k.length < 3) return null
    let best: { name: string; d: number } | null = null
    for (const n of known) {
      if (n.key === k) return null // Already right.
      const d = distance(k, n.key)
      const allowed = Math.max(1, Math.floor(n.key.length / 4))
      if (d <= allowed && (!best || d < best.d)) best = { name: n.name, d }
    }
    return best?.name ?? null
  }
  // Word by word: two capitalised words that together are a name ("Bran Ock"), or one.
  const words = t.split(' ')
  const cap = (w: string | undefined) => !!w && /^\p{Lu}/u.test(w)
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const tail = /[^\p{L}\p{N}']+$/u.exec(w)?.[0] ?? ''
    if (cap(w) && cap(words[i + 1]) && !close(w)) {
      const next = words[i + 1]!
      const nextTail = /[^\p{L}\p{N}']+$/u.exec(next)?.[0] ?? ''
      const both = close(w + next.slice(0, next.length - nextTail.length))
      if (both) {
        out.push(both + nextTail)
        i++
        continue
      }
    }
    const name = cap(w) ? close(w.slice(0, w.length - tail.length)) : null
    out.push(name ? name + tail : w)
  }
  t = out.join(' ')
  return t
}
