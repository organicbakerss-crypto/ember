import { describe, expect, it } from 'vitest'
import { forSpeech, planPassages, readyToPlay } from './passages'

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

  it('reads a long paragraph in sentence-sized pieces, never mid-sentence', () => {
    const para = Array.from(
      { length: 20 },
      (_, i) => `This is sentence ${i} of a long paragraph.`,
    ).join(' ')
    const p = planPassages([{ text: para }], { narrator: null, lines: {} }, cast)
    expect(p.length).toBeGreaterThan(2)
    for (const x of p) {
      expect(x.text.length).toBeLessThanOrEqual(350)
      expect(x.text.endsWith('.')).toBe(true)
    }
  })

  it('cleans text for the voice: no fancy quotes, dashes as pauses', () => {
    expect(forSpeech('“Well, yeah—but that was like… a whole *eight* days ago.”')).toBe(
      'Well, yeah, but that was like... a whole eight days ago.',
    )
  })

  it('waits until enough is made to play through, by how fast it’s going', () => {
    // Twice as fast as it plays: ready once a little is made.
    expect(
      readyToPlay({
        madeChars: 200,
        madeAudio: 10,
        madeTook: 5,
        buffered: 10,
        remainingChars: 200,
      }),
    ).toEqual({ ready: true, waitSecs: 0 })
    // As slow as it plays: wait, about half the time the rest takes.
    const slow = readyToPlay({
      madeChars: 200,
      madeAudio: 10,
      madeTook: 10,
      buffered: 10,
      remainingChars: 2000,
    })
    expect(slow.ready).toBe(false)
    expect(slow.waitSecs).toBeGreaterThan(40)
    expect(slow.waitSecs).toBeLessThan(70)
    // Nothing made yet: can't tell.
    expect(
      readyToPlay({ madeChars: 0, madeAudio: 0, madeTook: 0, buffered: 0, remainingChars: 100 }),
    ).toEqual({ ready: false, waitSecs: null })
  })
})
