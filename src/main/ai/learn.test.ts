import { describe, expect, it } from 'vitest'
import { parseLearned } from './learn'

describe('what an adaptive character learns', () => {
  it('takes new notes, one per line, skipping NONE, bullets and what is already known', () => {
    expect(parseLearned('NONE', [])).toEqual([])
    expect(
      parseLearned('- Prefers quiet scenes.\n2. Dislikes forced crises.\n- prefers quiet scenes', [
        'Dislikes forced crises',
      ]),
    ).toEqual(['Prefers quiet scenes.'])
  })
})
