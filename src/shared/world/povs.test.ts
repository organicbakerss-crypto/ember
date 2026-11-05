import { describe, expect, it } from 'vitest'
import { chapterPovs, headingPerson } from './povs'

const people = [
  { id: 'ent_0000000000000001', name: 'Mara Voss', aliases: ['the Fox'] },
  { id: 'ent_0000000000000002', name: 'Odo', aliases: [] },
  { id: 'ent_0000000000000003', name: 'Mara Hale', aliases: [] },
]

describe('POVs from scene headings', () => {
  it('reads a name, "Name interlude", "Name’s POV", "POV: Name"', () => {
    expect(headingPerson('Odo', people)?.name).toBe('Odo')
    expect(headingPerson('Odo interlude', people)?.name).toBe('Odo')
    expect(headingPerson('Mara Voss’s POV', people)?.name).toBe('Mara Voss')
    expect(headingPerson('POV: the Fox', people)?.name).toBe('Mara Voss')
    expect(headingPerson('Odo — the harbour', people)?.name).toBe('Odo')
    // "Mara" is two people: not guessed.
    expect(headingPerson('Mara', people)).toBeNull()
    expect(headingPerson('The storm breaks', people)).toBeNull()
  })

  it('keeps POVs set by hand first, adds heading ones once', () => {
    expect(
      chapterPovs(
        {
          pov: 'Odo',
          povEntryId: 'ent_0000000000000002',
          headings: ['Odo', 'Mara Hale interlude'],
        },
        people,
      ),
    ).toEqual([
      { name: 'Odo', entryId: 'ent_0000000000000002', fromHeading: false },
      { name: 'Mara Hale', entryId: 'ent_0000000000000003', fromHeading: true },
    ])
    expect(chapterPovs({ povs: [{ name: 'Vela', entryId: null }], headings: [] }, people)).toEqual([
      { name: 'Vela', entryId: null, fromHeading: false },
    ])
  })
})
