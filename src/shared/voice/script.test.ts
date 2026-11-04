import { describe, expect, it } from 'vitest'
import { audiobookScript, segments, speakable } from './script'

describe('chapters as lines to speak', () => {
  it('tidies line breaks and spaces inside a paragraph', () => {
    expect(speakable('“Are you serious?”\n She looked  annoyed.')).toBe(
      '“Are you serious?” She looked annoyed.',
    )
  })

  it('splits narration from dialogue, keeping a split line as two quotes', () => {
    const s = segments([
      {
        text: '“Hey, watch your language,” I shot back. “And ease up a little, will you?”',
      },
      { text: '“Ew. Grape.”\n I’ve always hated grape.' },
      { text: null },
      { text: 'Ashley sighed. "Maybe do the report."' },
    ])
    expect(s.map((x) => [x.block, x.kind, x.text])).toEqual([
      [0, 'quote', '“Hey, watch your language,”'],
      [0, 'narration', 'I shot back.'],
      [0, 'quote', '“And ease up a little, will you?”'],
      [1, 'quote', '“Ew. Grape.”'],
      [1, 'narration', 'I’ve always hated grape.'],
      [2, 'break', ''],
      [3, 'narration', 'Ashley sighed.'],
      [3, 'quote', '"Maybe do the report."'],
    ])
    expect(s[3]!.key).toBe('ew grape')
  })

  it('carries a quote left open into the next paragraph', () => {
    const s = segments([{ text: '“It was long ago.' }, { text: '“And then it ended.” He wept.' }])
    expect(s.map((x) => [x.kind, x.text])).toEqual([
      ['quote', '“It was long ago.'],
      ['quote', '“And then it ended.”'],
      ['narration', 'He wept.'],
    ])
  })

  it('writes the tagged script for VoiceStudio', () => {
    expect(
      audiobookScript([
        {
          heading: 'Ch 1: Arrival',
          lines: [
            { voice: 'Guy A', text: 'I ran.', kind: 'narration' },
            { voice: 'Ashley', text: '“Late again.”', kind: 'quote' },
            { voice: '', text: '', kind: 'break' },
          ],
        },
      ]),
    ).toBe('# Ch 1: Arrival\n[voice:Guy A] I ran.\n[voice:Ashley] “Late again.”\n[pause 1s]\n')
  })
})
