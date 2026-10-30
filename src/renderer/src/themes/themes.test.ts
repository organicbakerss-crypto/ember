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

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x! + 0.05) / (y! + 0.05)
}

describe('readable contrast in every theme', () => {
  for (const theme of themes) {
    it(`${theme.id}: text, page, buttons and muted text are readable`, () => {
      const c = theme.colors
      expect(contrast(c.text, c.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c.text, c.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c['page-text'], c.page)).toBeGreaterThanOrEqual(7)
      expect(contrast(c['accent-text'], c.accent)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c.muted, c.surface)).toBeGreaterThanOrEqual(3)
    })
  }
})
