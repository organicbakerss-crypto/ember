/**
 * A deliberately simple English stemmer, so that simple forms of a word count
 * as the same word: walk, walks, walked, walking → "walk". It doesn't need to
 * produce real words, only the same key for the same word.
 */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/’/g, "'")
  w = w.replace(/'s$/, '').replace(/s'$/, 's')
  if (w.length <= 3) return w

  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ied') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ing') && w.length > 5) w = undouble(w.slice(0, -3))
  else if (w.endsWith('ed') && w.length > 4) w = undouble(w.slice(0, -2))
  else if (/(?:s|x|z|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    w = w.slice(0, -1)
  }
  // "make", "makes", "making" and "made"-less forms meet at "mak".
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

/** running → run, stopped → stop (but not "fall", "kiss", "buzz"). */
function undouble(w: string): string {
  const last = w.at(-1)
  if (w.length > 3 && last === w.at(-2) && last && !'lsz'.includes(last) && !/[aeiou]/.test(last)) {
    return w.slice(0, -1)
  }
  return w
}
