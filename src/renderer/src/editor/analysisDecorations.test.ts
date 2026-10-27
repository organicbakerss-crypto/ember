import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { DEFAULT_FILLER_WORDS } from '@shared/analysis'
import { chapterExtensions } from './extensions'
import { buildDecorations, type AnalysisOptions } from './analysisDecorations'

const schema = getSchema(chapterExtensions())
const doc = (...paragraphs: string[]) =>
  Node.fromJSON(schema, {
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  })
const options = (patch: Partial<AnalysisOptions>): AnalysisOptions => ({
  rhythm: false,
  echo: false,
  highlightStem: null,
  words: { fillers: new Set(DEFAULT_FILLER_WORDS), names: new Set(), includeNames: false },
  echoRange: 50,
  rhythmMediumFrom: 10,
  rhythmLongFrom: 20,
  ...patch,
})
const spans = (d: Node, o: AnalysisOptions) =>
  buildDecorations(d, o, null)
    .decorations.find()
    .map((deco) => ({
      text: d.textBetween(deco.from, deco.to),
      attrs: (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs,
    }))

describe('analysis decorations', () => {
  it('colours each sentence by its length, with the word count on hover', () => {
    const medium = `Then ${Array(11).fill('more').join(' ')}`
    const long = `And ${Array(21).fill('more').join(' ')}`
    const d = doc(`Short one. ${medium}. ${long}.`)
    const result = spans(d, options({ rhythm: true }))
    expect(result.map((r) => r.attrs['class'])).toEqual([
      'rhythm rhythm-short',
      'rhythm rhythm-medium',
      'rhythm rhythm-long',
    ])
    expect(result[0]).toMatchObject({ text: 'Short one.', attrs: { title: '2 words' } })
    expect(result[2]!.attrs['title']).toBe('22 words')
  })

  it('marks echoes across paragraphs, each word in its own colour group', () => {
    const d = doc('The door creaked.', 'The doors opened onto rain, and rain fell.')
    const result = spans(d, options({ echo: true }))
    expect(result.map((r) => [r.text, r.attrs['class']])).toEqual([
      ['door', 'echo echo-0'],
      ['doors', 'echo echo-0'],
      ['rain', 'echo echo-1'],
      ['rain', 'echo echo-1'],
    ])
  })

  it('highlights every form of a chosen word', () => {
    const d = doc('She walked. Walking was easy; she walks daily.')
    const result = spans(d, options({ highlightStem: 'walk' }))
    expect(result.map((r) => r.text)).toEqual(['walked', 'Walking', 'walks'])
  })

  it('draws nothing when everything is off, and never changes the document', () => {
    const d = doc('Mara ran. Mara ran again.')
    const before = JSON.stringify(d.toJSON())
    expect(spans(d, options({}))).toEqual([])
    spans(d, options({ rhythm: true, echo: true, highlightStem: 'ran' }))
    expect(JSON.stringify(d.toJSON())).toBe(before)
  })
})
