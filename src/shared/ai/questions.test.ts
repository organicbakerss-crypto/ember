import { describe, expect, it } from 'vitest'
import { answersMessage, findQuestions } from './questions'

const block = (json: string) => `Before.\n\n\`\`\`questions\n${json}\n\`\`\`\n\nAfter.`

describe('questions from the AI', () => {
  it('reads a planned list with optional options and recommendations', () => {
    const found = findQuestions(
      block(
        '{"intro":"About the arc.","questions":[{"q":"Who betrays the crew?","options":["Eli","Sam","Mark"],"recommended":2,"why":"Pays off chapter 4."},{"q":"What does she fear?"}]}',
      ),
    )!
    expect(found.before).toBe('Before.')
    expect(found.after).toBe('After.')
    expect(found.set.intro).toBe('About the arc.')
    expect(found.set.questions[0]).toEqual({
      q: 'Who betrays the crew?',
      options: ['Eli', 'Sam', 'Mark'],
      recommended: 2,
      why: 'Pays off chapter 4.',
    })
    expect(found.set.questions[1]).toEqual({ q: 'What does she fear?' })
  })

  it('drops a recommendation that points at nothing, and leaves unreadable blocks as text', () => {
    const found = findQuestions(
      block('{"questions":[{"q":"A?","options":["x"],"recommended":5}]}'),
    )!
    expect(found.set.questions[0]).toEqual({ q: 'A?', options: ['x'] })
    expect(findQuestions(block('{not json'))).toBeNull()
    expect(findQuestions('no block here')).toBeNull()
  })

  it('sends the answers back, marking skipped and unreached ones', () => {
    const set = { questions: [{ q: 'One?' }, { q: 'Two?' }, { q: 'Three?' }] }
    const msg = answersMessage(set, ['Yes', null], true)
    expect(msg).toContain('I stopped the questions there')
    expect(msg).toContain('1. One?\n   → Yes')
    expect(msg).toContain('2. Two?\n   → (skipped)')
    expect(msg).toContain('3. Three?\n   → (not reached)')
    expect(msg).toContain('what’s strong and what’s weak')
  })
})
