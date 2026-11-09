import { describe, expect, it } from 'vitest'
import { parseSelectionAnswer, selectionPrompt, SELECTION_ACTIONS } from './selection'

describe('selection prompts', () => {
  it('builds a prompt for every action, with the selection and its context', () => {
    for (const action of SELECTION_ACTIONS) {
      const p = selectionPrompt({
        action,
        text: 'She walked slow.',
        before: 'Rain.',
        after: 'Josh waited.',
        character: { name: 'Sara', card: 'Name: Sara' },
      })
      expect(p.user).toContain('SELECTED TEXT:\nShe walked slow.')
      expect(p.user).toContain('Josh waited.')
      expect(p.system).toContain('"options"')
    }
    expect(
      selectionPrompt({
        action: 'voice',
        text: 'x',
        before: '',
        after: '',
        character: { name: 'Sara', card: 'Wants: a desk' },
      }).system,
    ).toContain('Wants: a desk')
  })
})

describe('reading the answer', () => {
  const req = { action: 'rephrase' as const, text: 'She walked slow.' }
  it('reads JSON, even with text around it', () => {
    const a = parseSelectionAnswer(
      'Sure:\n{"note": "", "options": ["She took her time.", "Slowly, she walked."]}\nDone',
      req,
    )
    expect(a.options).toEqual(['She took her time.', 'Slowly, she walked.'])
  })
  it('falls back to a numbered list, then to the whole reply', () => {
    expect(parseSelectionAnswer('1. One way.\n2. Another way.', req).options).toEqual([
      'One way.',
      'Another way.',
    ])
    expect(parseSelectionAnswer('Just this.', req).options).toEqual(['Just this.'])
  })
  it('drops quotes the model added, keeps quotes the text had', () => {
    expect(parseSelectionAnswer('{"options": ["\\"She took her time.\\""]}', req).options).toEqual([
      'She took her time.',
    ])
    const quoted = { action: 'rephrase' as const, text: '"No," she said.' }
    expect(parseSelectionAnswer('{"options": ["\\"Nope,\\" she said."]}', quoted).options).toEqual([
      '"Nope," she said.',
    ])
  })
  it('drops empty and repeated options and caps the count', () => {
    const a = parseSelectionAnswer('{"options": ["a", "", "a", "b", "c", "d"]}', req)
    expect(a.options).toEqual(['a', 'b', 'c'])
  })
  it('a fix that changes nothing says so instead of offering the same text', () => {
    const fix = { action: 'fix' as const, text: 'Fine as is.' }
    expect(parseSelectionAnswer('{"note": "", "options": ["Fine as is."]}', fix)).toEqual({
      note: 'Nothing to fix.',
      options: [],
    })
  })
  it('better word keeps up to eight', () => {
    const word = { action: 'word' as const, text: 'slow' }
    const a = parseSelectionAnswer('{"options": ["1","2","3","4","5","6","7","8","9"]}', word)
    expect(a.options).toHaveLength(8)
  })
})
