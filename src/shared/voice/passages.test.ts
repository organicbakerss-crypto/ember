import { describe, expect, it } from 'vitest'
import { planPassages } from './passages'

const cast = { narrator: 'Calm', other: 'Plain', characters: { Ashley: 'Bright', Guy: 'Deep' } }

describe('passages to read aloud', () => {
  it('runs lines in the same voice together, with pauses only between voices and scenes', () => {
    const p = planPassages(
      [
        { text: '“Hey,” I shot back. “Ease up.”' },
        { text: '“Are you serious?”\n She looked annoyed.' },
        { text: 'It was late.' },
        { text: null },
        { text: '“Who’s there?”' },
      ],
      {
        narrator: 'Guy',
        lines: { hey: 'Guy', 'ease up': 'Guy', 'are you serious': 'Ashley', 'whos there': 'Zed' },
      },
      cast,
    )
    expect(p.map((x) => [x.voice, x.text, x.blocks, x.pauseBefore])).toEqual([
      ['Deep', '“Hey,” I shot back. “Ease up.”', [0], 0],
      ['Bright', '“Are you serious?”', [1], 150],
      ['Deep', 'She looked annoyed. It was late.', [1, 2], 150],
      ['Plain', '“Who’s there?”', [4], 900],
    ])
  })

  it('third person: narration in the narrator’s voice', () => {
    const p = planPassages([{ text: 'Mara ran.' }], { narrator: null, lines: {} }, cast)
    expect(p[0]!.voice).toBe('Calm')
  })

  it('keeps the first passage short so it starts quickly', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ text: `Sentence number ${i} here.` }))
    const p = planPassages(long, { narrator: null, lines: {} }, cast)
    expect(p[0]!.text.length).toBeLessThan(250)
    expect(p[1]!.text.length).toBeGreaterThan(p[0]!.text.length)
  })
})
