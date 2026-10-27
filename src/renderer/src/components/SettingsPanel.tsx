import { useEffect, useState } from 'react'
import { PAGE_WIDTH, type AppSettings } from '@shared/settings'
import { api, useIpcEvent } from '../api'
import { SYSTEM_THEME, themes } from '../themes'

/** App settings. For now: the theme. */
export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [languages, setLanguages] = useState<string[]>([])
  const [newWord, setNewWord] = useState('')
  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
    void api.invoke('spelling:languages').then(setLanguages)
  }, [])
  useIpcEvent('settings:changed', setSettings)
  if (!settings) return null

  const change = (patch: Partial<AppSettings>) => {
    setSettings({ ...settings, ...patch })
    void api.invoke('settings:update', patch)
  }
  const options = [{ id: SYSTEM_THEME, name: 'Match system (light or dark)' }, ...themes]

  return (
    <div className="settings-panel">
      <h2>Settings</h2>
      <fieldset>
        <legend>Theme</legend>
        {options.map((theme) => (
          <label key={theme.id} className="radio">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === theme.id}
              onChange={() => change({ theme: theme.id })}
            />
            {theme.name}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Spelling</legend>
        <label className="radio">
          <input
            type="checkbox"
            checked={settings.spellcheck}
            onChange={(e) => change({ spellcheck: e.target.checked })}
          />
          Check spelling as I type
        </label>
        {languages.length > 0 && (
          <label>
            Language
            <select
              value={settings.spellLanguages[0] ?? ''}
              disabled={!settings.spellcheck}
              onChange={(e) => change({ spellLanguages: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">System language</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <details className="dictionary">
          <summary className="small">
            Personal dictionary ({settings.dictionary.length}{' '}
            {settings.dictionary.length === 1 ? 'word' : 'words'})
          </summary>
          <p className="muted small">Right-click a flagged word in the page to add it here.</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const word = newWord.trim()
              if (word && !settings.dictionary.includes(word)) {
                change({ dictionary: [...settings.dictionary, word].sort() })
              }
              setNewWord('')
            }}
          >
            <input
              aria-label="Add a word"
              placeholder="Add a word"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
            />
          </form>
          <ul className="dictionary-list">
            {settings.dictionary.map((word) => (
              <li key={word}>
                <span>{word}</span>
                <button
                  className="icon"
                  title={`Remove “${word}”`}
                  aria-label={`Remove ${word}`}
                  onClick={() =>
                    change({ dictionary: settings.dictionary.filter((w) => w !== word) })
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </details>
      </fieldset>
      <fieldset>
        <legend>Page width</legend>
        <input
          type="range"
          aria-label="Page width"
          min={PAGE_WIDTH.min}
          max={PAGE_WIDTH.max}
          step={20}
          value={settings.pageWidth}
          onChange={(e) => change({ pageWidth: Number(e.target.value) })}
        />
        <span className="muted small">
          {settings.pageWidth}px text column
          {settings.pageWidth === PAGE_WIDTH.default ? ' (default)' : ''}
          {settings.pageWidth !== PAGE_WIDTH.default && (
            <>
              {' · '}
              <button
                className="link small"
                onClick={() => change({ pageWidth: PAGE_WIDTH.default })}
              >
                Reset
              </button>
            </>
          )}
        </span>
      </fieldset>
    </div>
  )
}
