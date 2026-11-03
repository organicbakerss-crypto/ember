import { describe, expect, it } from 'vitest'
import {
  chapterLine,
  chapterUnits,
  isSceneBreakLine,
  proposeSplits,
  unitsWords,
  type ImportUnit,
} from './importSplit'

const u = (tag: string, text: string): ImportUnit => ({ tag, text })

describe('splitting an import into chapters', () => {
  it('reads chapter lines and their titles', () => {
    expect(chapterLine('Chapter 3: The Storm')).toEqual({ title: 'The Storm', type: 'chapter' })
    expect(chapterLine('CHAPTER TWENTY-ONE')).toEqual({ title: '', type: 'chapter' })
    expect(chapterLine('Ch. XII — Ashes')).toEqual({ title: 'Ashes', type: 'chapter' })
    expect(chapterLine('Prologue')).toEqual({ title: 'Prologue', type: 'chapter' })
    expect(chapterLine('Interlude: The Tide')).toEqual({ title: 'The Tide', type: 'interlude' })
    expect(chapterLine('Chapters of my life were long.')).toBeNull()
    expect(chapterLine('The chapter 3 we read.')).toBeNull()
  })

  it('knows scene-break lines', () => {
    for (const t of ['***', '* * *', '#', '⁂', '~~~', '---']) expect(isSceneBreakLine(t)).toBe(true)
    for (const t of ['', 'A*B', '* then words']) expect(isSceneBreakLine(t)).toBe(false)
  })

  const doc = [
    u('p', 'My Book'),
    u('p', 'by me'),
    u('h1', 'Chapter 1: Arrival'),
    u('p', 'Mara came.'),
    u('p', '* * *'),
    u('p', 'Night fell.'),
    u('p', 'Chapter 2'),
    u('p', 'Storm.'),
    u('h1', 'Epilogue'),
    u('p', 'The end.'),
  ]

  it('splits at headings and chapter lines, keeping the front matter apart', () => {
    const starts = proposeSplits(doc, 'auto')
    expect(starts.map((s) => [s.at, s.title, s.consumes])).toEqual([
      [0, '', false],
      [2, 'Arrival', true],
      [6, '', true],
      [8, 'Epilogue', true],
    ])
    expect(chapterUnits(doc, starts, 1).map((x) => x.text)).toEqual([
      'Mara came.',
      '* * *',
      'Night fell.',
    ])
    expect(unitsWords(chapterUnits(doc, starts, 0))).toBe(4)
  })

  it('follows the chosen rule', () => {
    expect(proposeSplits(doc, 'headings').map((s) => [s.at, s.title])).toEqual([
      [0, ''],
      [2, 'Arrival'],
      [8, 'Epilogue'],
    ])
    expect(proposeSplits(doc, 'lines').map((s) => s.at)).toEqual([0, 2, 6, 8])
    expect(proposeSplits(doc, 'none')).toEqual([
      { at: 0, title: '', type: 'chapter', consumes: false },
    ])
  })

  it('uses the top heading level a document has', () => {
    const h2s = [
      u('h2', 'The Beginning'),
      u('p', 'a'),
      u('h3', 'A scene'),
      u('p', 'b'),
      u('h2', 'The Middle'),
      u('p', 'c'),
    ]
    expect(proposeSplits(h2s, 'auto').map((s) => [s.at, s.title])).toEqual([
      [0, 'The Beginning'],
      [4, 'The Middle'],
    ])
  })
})
