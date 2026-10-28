import { describe, expect, it } from 'vitest'
import { guessTemplate } from './guess'

describe('guessTemplate', () => {
  it('guesses from words in the name', () => {
    expect(guessTemplate('The Iron Kingdom')).toBe('kingdom')
    expect(guessTemplate('Thieves’ Guild')).toBe('faction')
    expect(guessTemplate('House Voss')).toBe('family')
    expect(guessTemplate('Battle of Saltmere')).toBe('event')
    expect(guessTemplate('Darkwood Forest')).toBe('wilds')
    expect(guessTemplate('Port Gull')).toBe('city')
  })

  it('guesses a place from the words before a name', () => {
    expect(guessTemplate('Gullhaven', 'She sailed into ')).toBe('city')
    expect(guessTemplate('Saltmere', 'They came from')).toBe('city')
  })

  it('has no guess for a plain name', () => {
    expect(guessTemplate('Mara', 'Then ')).toBeNull()
  })
})
