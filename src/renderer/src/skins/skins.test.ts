import { describe, expect, it } from 'vitest'
import { themes } from '../themes'
import { applySkin, SKIN_WORDS, skinFor, skins } from './index'

describe('world skins', () => {
  it('are the three full skins, each named by a theme', () => {
    expect(skins.map((s) => s.id).sort()).toEqual(['arcade', 'cyberpunk', 'fantasy'])
    for (const theme of themes.filter((t) => t.skin)) expect(skinFor(theme)).not.toBeNull()
    expect(skinFor(themes.find((t) => t.id === 'light')!)).toBeNull()
  })

  for (const skin of skins) {
    it(`${skin.id} has every word and its art tokens`, () => {
      expect(Object.keys(skin.words).sort()).toEqual([...SKIN_WORDS].sort())
      for (const w of Object.values(skin.words)) expect(w.trim()).toBeTruthy()
      for (const token of ['heading-font', 'map-filter', 'region-stroke', 'region-hover'])
        expect(skin.tokens[token]).toBeTruthy()
    })
  }

  it('applies a skin at each level, and clears it', () => {
    const props = new Map<string, string>()
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k),
        getPropertyValue: (k: string) => props.get(k) ?? '',
      },
    } as unknown as HTMLElement
    const fantasy = skins.find((s) => s.id === 'fantasy')!
    applySkin(fantasy, 'full', root)
    expect(root.dataset['skin']).toBe('fantasy')
    expect(root.dataset['skinArt']).toBe('')
    expect(root.style.getPropertyValue('--skin-ink')).toBe('#3b2614')
    applySkin(fantasy, 'plain', root)
    expect(root.dataset['skin']).toBe('fantasy')
    expect(root.dataset['skinArt']).toBeUndefined()
    applySkin(fantasy, 'minimal', root)
    expect(root.dataset['skin']).toBeUndefined()
    expect(root.style.getPropertyValue('--skin-ink')).toBe('')
  })
})
