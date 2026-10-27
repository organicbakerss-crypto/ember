/**
 * Themes are data files in this folder: adding a theme means adding a JSON
 * file, not code. Each one covers the app chrome and the page.
 */
export const THEME_COLOR_TOKENS = [
  'bg',
  'surface',
  'surface-2',
  'text',
  'muted',
  'border',
  'accent',
  'accent-text',
  'accent-soft',
  'danger',
  'warning-bg',
  'desk',
  'page',
  'page-text',
  'selection',
  'cover-text',
  'cover-0',
  'cover-1',
  'cover-2',
  'cover-3',
  'cover-4',
  'cover-5',
  'cover-6',
  'cover-7',
  'cover-shadow',
  'page-shadow',
] as const

export const THEME_PAGE_TOKENS = [
  'width',
  'padding',
  'font-size',
  'line-height',
  'paragraph-spacing',
  'text-indent',
] as const

export interface Theme {
  id: string
  name: string
  /** Which system appearance this theme suits; also sets native form controls. */
  appearance: 'light' | 'dark'
  colors: Record<(typeof THEME_COLOR_TOKENS)[number], string>
  /** `ui` is for the app chrome; `page` must be a readable writing font. */
  fonts: { ui: string; page: string }
  page: Record<(typeof THEME_PAGE_TOKENS)[number], string>
}

const files = import.meta.glob<Theme>('./*.json', { eager: true, import: 'default' })

export const themes: Theme[] = Object.values(files).sort((a, b) =>
  a.appearance === b.appearance ? a.name.localeCompare(b.name) : a.appearance === 'light' ? -1 : 1,
)

export const SYSTEM_THEME = 'system'

/** Resolves a setting (`system` or a theme id) to a theme, falling back to light/dark. */
export function resolveTheme(setting: string, prefersDark: boolean): Theme {
  const fallback = themes.find((t) => t.id === (prefersDark ? 'dark' : 'light')) ?? themes[0]!
  if (setting === SYSTEM_THEME) return fallback
  return themes.find((t) => t.id === setting) ?? fallback
}

/** Applies a theme as CSS custom properties on the document. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  for (const token of THEME_COLOR_TOKENS) root.style.setProperty(`--${token}`, theme.colors[token])
  for (const token of THEME_PAGE_TOKENS)
    root.style.setProperty(`--page-${token}`, theme.page[token])
  root.style.setProperty('--ui-font', theme.fonts.ui)
  root.style.setProperty('--page-font', theme.fonts.page)
  root.style.colorScheme = theme.appearance
  root.dataset['theme'] = theme.id
}
