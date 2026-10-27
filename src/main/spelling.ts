/**
 * Spellcheck: Electron's built-in checker plus a personal dictionary kept in
 * the app settings (so it can be synced with them later), and the right-click
 * menu for text fields with suggestions and "Add to dictionary".
 */
import { app, Menu, type BrowserWindow, type ContextMenuParams, type Session } from 'electron'
import type { AppSettings } from '@shared/ipc'
import type { AppSettingsStore } from './appSettings'

const MAX_SUGGESTIONS = 5

/** Brings the session in line with the settings (all of it, or only what changed). */
export function applySpelling(session: Session, next: AppSettings, previous?: AppSettings): void {
  session.setSpellCheckerEnabled(next.spellcheck)
  if (process.platform !== 'darwin') {
    const available = session.availableSpellCheckerLanguages
    const wanted = next.spellLanguages.filter((l) => available.includes(l))
    session.setSpellCheckerLanguages(wanted.length ? wanted : [systemLanguage(available)])
  }
  const before = new Set(previous?.dictionary ?? [])
  const after = new Set(next.dictionary)
  for (const word of after) if (!before.has(word)) session.addWordToSpellCheckerDictionary(word)
  for (const word of before)
    if (!after.has(word)) session.removeWordFromSpellCheckerDictionary(word)
}

function systemLanguage(available: string[]): string {
  const locale = app.getLocale()
  return (
    available.find((l) => l === locale) ??
    available.find((l) => l.split('-')[0] === locale.split('-')[0]) ??
    (available.includes('en-US') ? 'en-US' : (available[0] ?? 'en-US'))
  )
}

/**
 * The native right-click menu for text: spelling suggestions, add to
 * dictionary, cut/copy/paste. Custom menus in the app prevent this one.
 */
export function attachTextMenu(
  window: BrowserWindow,
  settings: AppSettingsStore,
  onSettingsChanged: (next: AppSettings) => void,
): void {
  window.webContents.on('context-menu', (_event, params: ContextMenuParams) => {
    const items: Electron.MenuItemConstructorOptions[] = []
    const word = params.misspelledWord
    if (word) {
      for (const suggestion of params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) {
        items.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        })
      }
      if (!params.dictionarySuggestions.length)
        items.push({ label: 'No suggestions', enabled: false })
      items.push(
        {
          label: `Add “${word}” to dictionary`,
          click: async () => {
            const current = await settings.read()
            if (current.dictionary.includes(word)) return
            const next = await settings.update({ dictionary: [...current.dictionary, word].sort() })
            window.webContents.session.addWordToSpellCheckerDictionary(word)
            onSettingsChanged(next)
          },
        },
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window })
  })
}
