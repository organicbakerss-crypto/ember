import { describe, expect, it } from 'vitest'
import { resolveTheme, THEME_COLOR_TOKENS, THEME_PAGE_TOKENS, themes } from './index'

describe('theme files', () => {
  it('include light and dark, with unique ids', () => {
    const ids = themes.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['light', 'dark']))
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const theme of themes) {
    it(`${theme.id} defines every token`, () => {
      expect(theme.name).toBeTruthy()
      expect(['light', 'dark']).toContain(theme.appearance)
      expect(Object.keys(theme.colors).sort()).toEqual([...THEME_COLOR_TOKENS].sort())
      expect(Object.keys(theme.page).sort()).toEqual([...THEME_PAGE_TOKENS].sort())
      expect(theme.fonts.ui && theme.fonts.page).toBeTruthy()
    })
  }

  it('resolves the system setting and unknown ids to light or dark', () => {
    expect(resolveTheme('system', true).id).toBe('dark')
    expect(resolveTheme('system', false).id).toBe('light')
    expect(resolveTheme('deleted-theme', true).id).toBe('dark')
    expect(resolveTheme('light', true).id).toBe('light')
  })
})
