import { describe, expect, it } from 'vitest'
import { cleanDictation } from './dictation'

describe('tidying dictation', () => {
  it('turns spoken quotes into quote marks', () => {
    expect(cleanDictation('She said quote, Ew. Grape, end quote. Then left.', [])).toBe(
      'She said “Ew. Grape”. Then left.',
    )
  })

  it('fixes near-misses of the world’s names, leaving ordinary words alone', () => {
    const names = ['Brannoch', 'Saltmarch', 'Ashley', 'Mara']
    expect(cleanDictation('Then Bran Ock saw Ashlee at Saltmarsh.', names)).toBe(
      'Then Brannoch saw Ashley at Saltmarch.',
    )
    expect(cleanDictation('The mare ran past Mara.', names)).toBe('The mare ran past Mara.')
  })
})
