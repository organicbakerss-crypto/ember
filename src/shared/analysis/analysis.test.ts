import { describe, expect, it } from 'vitest'
import {
  computeStats,
  DEFAULT_FILLER_WORDS,
  dialogueRanges,
  findEchoes,
  repeatedWords,
  splitSentences,
  stem,
  tokenize,
} from './index'

const sentences = (text: string) => splitSentences(text).map((r) => text.slice(r.start, r.end))
const options = (names: string[] = [], includeNames = false) => ({
  fillers: new Set(DEFAULT_FILLER_WORDS),
  names: new Set(names),
  includeNames,
})

describe('splitSentences', () => {
  it('splits plain sentences', () => {
    expect(sentences('The storm came. Nobody slept! Did you? Yes.')).toEqual([
      'The storm came.',
      'Nobody slept!',
      'Did you?',
      'Yes.',
    ])
  })

  it('keeps a dialogue tag with its quote', () => {
    expect(sentences('"Where are you going?" she asked. "Home."')).toEqual([
      '"Where are you going?" she asked.',
      '"Home."',
    ])
    expect(sentences('“Run!” he shouted, and they ran.')).toEqual([
      '“Run!” he shouted, and they ran.',
    ])
  })

  it('splits after a quote that ends a sentence', () => {
    expect(sentences('He said, “Go.” Then he left.')).toEqual(['He said, “Go.”', 'Then he left.'])
  })

  it('handles ellipses in the middle and at the end of a thought', () => {
    expect(sentences('He waited... and waited. Nothing.')).toEqual([
      'He waited... and waited.',
      'Nothing.',
    ])
    expect(sentences('She paused… Then she spoke.')).toEqual(['She paused…', 'Then she spoke.'])
  })

  it('never splits on em dashes', () => {
    expect(sentences('He reached for the door—then stopped. Silence.')).toEqual([
      'He reached for the door—then stopped.',
      'Silence.',
    ])
    expect(sentences('“I was going to—” “Stop.”')).toEqual(['“I was going to—” “Stop.”'])
  })

  it('does not split on abbreviations or initials', () => {
    expect(sentences('Mr. Hale met Dr. Okafor on St. James Street. They talked.')).toEqual([
      'Mr. Hale met Dr. Okafor on St. James Street.',
      'They talked.',
    ])
    expect(sentences('J. R. R. Tolkien wrote it. I agree.')).toEqual([
      'J. R. R. Tolkien wrote it.',
      'I agree.',
    ])
    expect(sentences('Bring tools, e.g. a hammer. Go.')).toEqual([
      'Bring tools, e.g. a hammer.',
      'Go.',
    ])
  })

  it('handles ?! runs, numbers and line breaks', () => {
    expect(sentences('You did what?! Unbelievable.')).toEqual(['You did what?!', 'Unbelievable.'])
    expect(sentences('It cost 3.50 coins. Cheap.')).toEqual(['It cost 3.50 coins.', 'Cheap.'])
    expect(sentences('Dear Mara,\nCome home')).toEqual(['Dear Mara,', 'Come home'])
  })

  it('ignores empty input and punctuation alone', () => {
    expect(sentences('')).toEqual([])
    expect(sentences('* * *')).toEqual([])
  })
})

describe('stem', () => {
  it('treats simple forms of a word as the same', () => {
    const forms = (...words: string[]) => new Set(words.map(stem))
    expect(forms('walk', 'walks', 'walked', 'walking').size).toBe(1)
    expect(forms('run', 'runs', 'running').size).toBe(1)
    expect(forms('stop', 'stops', 'stopped', 'stopping').size).toBe(1)
    expect(forms('make', 'makes', 'making').size).toBe(1)
    expect(forms('cry', 'cries', 'cried').size).toBe(1)
    expect(forms('box', 'boxes').size).toBe(1)
    expect(forms('Mara', "Mara's", 'Mara’s').size).toBe(1)
  })

  it('keeps different words apart', () => {
    expect(stem('walk')).not.toBe(stem('wall'))
    expect(stem('glass')).toBe('glass')
    expect(stem('bus')).toBe('bus')
  })
})

describe('dialogue', () => {
  it('finds quoted speech in several quote styles', () => {
    const text = '“Go,” she said. "Now." «Vite!» ‘Quiet,’ he whispered.'
    const parts = dialogueRanges(text).map((r) => text.slice(r.start, r.end))
    expect(parts).toEqual(['“Go,”', '"Now."', '«Vite!»', '‘Quiet,’'])
  })

  it('does not mistake apostrophes for quotes', () => {
    const text = 'It’s Mara’s boat, isn’t it?'
    expect(dialogueRanges(text)).toEqual([])
  })

  it('runs an unclosed quote to the end of the paragraph', () => {
    const text = '“This speech goes on'
    expect(dialogueRanges(text)).toEqual([{ start: 0, end: text.length }])
  })
})

describe('computeStats', () => {
  it('counts words, sentences, paragraphs, dialogue and -ly adverbs', () => {
    const stats = computeStats([
      '“Run,” she said quickly. They ran.',
      'The family walked slowly home, early and lonely.',
      '',
    ])
    expect(stats.words).toBe(14)
    expect(stats.sentences).toBe(3)
    expect(stats.longestSentenceWords).toBe(8)
    expect(stats.paragraphs).toBe(2)
    expect(stats.longestParagraphWords).toBe(8)
    expect(stats.avgParagraphWords).toBe(7)
    expect(stats.lyAdverbs).toBe(2) // quickly, slowly (not family, early, lonely)
    expect(stats.dialoguePercent).toBeCloseTo((1 / 14) * 100)
    expect(stats.pages).toBeCloseTo(14 / 250)
  })

  it('handles empty text', () => {
    expect(computeStats([])).toMatchObject({ words: 0, sentences: 0, varietyPercent: 0 })
  })

  it('gives repetitive text a lower variety than varied text', () => {
    const repetitive = computeStats([Array(300).fill('the cat sat').join(' ')])
    const varied = computeStats([Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')])
    expect(repetitive.varietyPercent).toBeLessThan(10)
    expect(varied.varietyPercent).toBe(100)
  })
})

describe('repeatedWords', () => {
  it('counts content words across forms, leaving out fillers and names by default', () => {
    const paragraphs = ['Mara walked. She walks and walked again.', 'Mara was walking with Mara.']
    const top = repeatedWords(paragraphs, options(['mara']))
    expect(top[0]).toEqual({ stem: 'walk', count: 4, word: 'walked' })
    expect(top.find((w) => w.word === 'mara')).toBeUndefined()
    expect(top.find((w) => w.word === 'she' || w.word === 'and')).toBeUndefined()
    const withNames = repeatedWords(paragraphs, options(['mara'], true))
    expect(withNames.find((w) => w.word === 'mara')?.count).toBe(3)
  })
})

describe('findEchoes', () => {
  it('marks repeats within range, gives each word its own colour, and groups nearby repeats', () => {
    const text =
      'The door opened. A door closed. Rain fell on the roof and rain ran down. ' +
      Array(60).fill('x').join(' ') +
      ' The door again.'
    const tokens = tokenize(text)
    const { marks, clusters } = findEchoes(tokens, options(), 50)
    const marked = [...marks.keys()].map((i) => tokens[i]!.lower)
    expect(marked).toEqual(['door', 'door', 'rain', 'rain'])
    const groups = new Set([...marks.values()].map((m) => m.group))
    expect(groups.size).toBe(2)
    expect(clusters).toHaveLength(2)
    // The third "door" is more than 50 words away, so it isn't an echo.
    expect(marks.has(tokens.findLastIndex((t) => t.lower === 'door'))).toBe(false)
  })

  it('matches simple forms and ignores fillers and names', () => {
    const tokens = tokenize('Mara walked to Mara. She walks.')
    const { marks } = findEchoes(tokens, options(['mara']), 50)
    expect([...marks.keys()].map((i) => tokens[i]!.lower)).toEqual(['walked', 'walks'])
  })
})
