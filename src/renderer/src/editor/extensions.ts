import StarterKit from '@tiptap/starter-kit'
import { Color, FontFamily, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import type { Extensions } from '@tiptap/core'
import { SceneBreak } from './sceneBreak'

/** The editor's schema. Changing it changes what chapter files can contain. */
export function chapterExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      // Not novel features; scene breaks replace the horizontal rule.
      code: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
    }),
    TextStyle,
    Color,
    FontFamily,
    SceneBreak,
    Placeholder.configure({ placeholder: 'Start writing…' }),
  ]
}

/** Font choices offered in the toolbar. `null` means the theme's page font. */
export const FONT_CHOICES: { label: string; value: string | null }[] = [
  { label: 'Theme font', value: null },
  { label: 'Serif', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Book', value: "'EB Garamond', Garamond, 'Palatino Linotype', Palatino, serif" },
  { label: 'Sans', value: "system-ui, 'Helvetica Neue', Arial, sans-serif" },
  { label: 'Typewriter', value: "'Courier Prime', 'Courier New', Courier, monospace" },
]

/** Text colours offered in the toolbar, chosen to stay readable on light and dark pages. */
export const COLOR_CHOICES: { label: string; value: string | null }[] = [
  { label: 'Default', value: null },
  { label: 'Red', value: '#c0392b' },
  { label: 'Orange', value: '#d9771f' },
  { label: 'Green', value: '#2e9b5f' },
  { label: 'Blue', value: '#2e7bd6' },
  { label: 'Purple', value: '#8e54b0' },
  { label: 'Grey', value: '#888888' },
]
