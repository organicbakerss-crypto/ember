/**
 * World skins make World mode feel like the story: frames, typography, map
 * styling, transitions and words. A skin is data, not code: a JSON file (its
 * words, and art tokens set as `--skin-*` custom properties) and a CSS file
 * of art scoped to `[data-skin="<id>"]`. A theme names its skin; the layout
 * and data underneath are the same in every skin. The writing page is never
 * skinned.
 */
import '@fontsource/cinzel/500.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/share-tech-mono/400.css'
import '@fontsource/press-start-2p/400.css'
import type { Theme } from '../themes'

/** Words a skin can replace (its vocabulary); each falls back to the plain word. */
export const SKIN_WORDS = ['world', 'where', 'who', 'when', 'how', 'inbox', 'now'] as const
export type SkinWord = (typeof SKIN_WORDS)[number]

export interface Skin {
  id: string
  name: string
  words: Partial<Record<SkinWord, string>>
  /** Art tokens, set as `--skin-<name>` on the document. */
  tokens: Record<string, string>
}

/** How much of a skin shows (Settings → World). */
export type SkinLevel = 'full' | 'plain' | 'minimal'

const files = import.meta.glob<Skin>('./*.json', { eager: true, import: 'default' })
import.meta.glob('./*.css', { eager: true })

export const skins: Skin[] = Object.values(files)

export function skinFor(theme: Pick<Theme, 'skin'>): Skin | null {
  return skins.find((s) => s.id === theme.skin) ?? null
}

let applied: string[] = []

/**
 * Applies a skin to the document. `full`: art, fonts, map styling and
 * transitions; `plain`: fonts and map styling without textures, frames or
 * transitions; `minimal`: the clean default layout in the theme's colours.
 */
export function applySkin(
  skin: Skin | null,
  level: SkinLevel,
  root: HTMLElement = document.documentElement,
): void {
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  if (!skin || level === 'minimal') {
    delete root.dataset['skin']
    delete root.dataset['skinArt']
    return
  }
  root.dataset['skin'] = skin.id
  if (level === 'full') root.dataset['skinArt'] = ''
  else delete root.dataset['skinArt']
  for (const [name, value] of Object.entries(skin.tokens)) {
    root.style.setProperty(`--skin-${name}`, value)
    applied.push(`--skin-${name}`)
  }
}
