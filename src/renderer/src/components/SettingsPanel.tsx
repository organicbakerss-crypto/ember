import { useEffect, useState } from 'react'
import { PAGE_WIDTH, PAPER_SIZES, type AnalysisSettings, type PaperSize } from '@shared/settings'
import { DEFAULT_FILLER_WORDS } from '@shared/analysis/fillers'
import { api } from '../api'
import { useSettings } from '../useTheme'
import { SYSTEM_THEME, themes } from '../themes'

/** App settings. For now: the theme. */
export function SettingsPanel() {
  const { settings, update: change } = useSettings()
  const [languages, setLanguages] = useState<string[]>([])
  const [newWord, setNewWord] = useState('')
  useEffect(() => {
    void api.invoke('spelling:languages').then(setLanguages)
  }, [])

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
      <AnalysisSettingsSection />
      <fieldset>
        <legend>Page</legend>
        <div className="segmented" role="radiogroup" aria-label="Page view">
          {(
            [
              ['pages', 'Separate pages'],
              ['continuous', 'Continuous'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={settings.pageView === value}
              className={settings.pageView === value ? 'active' : ''}
              onClick={() => change({ pageView: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="small">
          Paper size
          <select
            value={settings.paperSize}
            onChange={(e) => change({ paperSize: e.target.value as PaperSize })}
          >
            {Object.entries(PAPER_SIZES).map(([id, paper]) => (
              <option key={id} value={id}>
                {paper.label}
              </option>
            ))}
          </select>
        </label>
        <span className="small">Width</span>
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

const BANDS = [
  { key: 'short', label: 'Short' },
  { key: 'medium', label: 'Medium' },
  { key: 'long', label: 'Long' },
] as const

/** Rhythm, Echo and the shared filler-word list. */
function AnalysisSettingsSection() {
  const { settings, update } = useSettings()
  const a = settings.analysis
  const set = (patch: Partial<AnalysisSettings>) => update({ analysis: { ...a, ...patch } })
  const [fillers, setFillers] = useState(a.fillerWords.join(', '))
  const [wasFillers, setWasFillers] = useState(a.fillerWords)
  if (wasFillers !== a.fillerWords) {
    setWasFillers(a.fillerWords)
    setFillers(a.fillerWords.join(', '))
  }
  const themeColor = (band: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(`--rhythm-${band}`).trim() ||
    '#888888'
  const saveFillers = () => {
    const list = [
      ...new Set(
        fillers
          .split(/[,\n]+/)
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean),
      ),
    ]
    set({ fillerWords: list })
  }

  return (
    <fieldset className="analysis-settings">
      <legend>Writing analysis</legend>
      <p className="muted small">
        Rhythm and Echo are toggled on the toolbar. Everything is worked out on this device.
      </p>
      <div className="row small">
        <label>
          Medium from
          <input
            type="number"
            min={2}
            max={a.rhythmLongFrom - 1}
            value={a.rhythmMediumFrom}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v >= 2 && v < a.rhythmLongFrom) set({ rhythmMediumFrom: v })
            }}
          />
        </label>
        <label>
          Long from
          <input
            type="number"
            min={a.rhythmMediumFrom + 1}
            max={200}
            value={a.rhythmLongFrom}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v > a.rhythmMediumFrom && v <= 200) set({ rhythmLongFrom: v })
            }}
          />
        </label>
      </div>
      <p className="muted small">
        Rhythm: under {a.rhythmMediumFrom} words is short, {a.rhythmMediumFrom}–
        {a.rhythmLongFrom - 1} medium, {a.rhythmLongFrom}+ long.
      </p>
      <div className="row small">
        {BANDS.map((b) => (
          <label key={b.key} className="color-pick">
            {b.label}
            <input
              type="color"
              value={a.rhythmColors[b.key] ?? themeColor(b.key)}
              onChange={(e) =>
                set({ rhythmColors: { ...a.rhythmColors, [b.key]: e.target.value } })
              }
            />
          </label>
        ))}
        {(a.rhythmColors.short || a.rhythmColors.medium || a.rhythmColors.long) && (
          <button
            className="link small"
            onClick={() => {
              for (const b of BANDS)
                document.documentElement.style.removeProperty(`--rhythm-${b.key}`)
              set({ rhythmColors: { short: null, medium: null, long: null } })
            }}
          >
            Use theme colours
          </button>
        )}
      </div>
      <label className="small">
        Echo range (words)
        <input
          type="number"
          min={5}
          max={500}
          value={a.echoRange}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v >= 5 && v <= 500) set({ echoRange: v })
          }}
        />
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={a.includeNames}
          onChange={(e) => set({ includeNames: e.target.checked })}
        />
        Include character and place names
      </label>
      <label className="small">
        Filler words (left out of Echo and repeated words)
        <textarea
          rows={4}
          value={fillers}
          onChange={(e) => setFillers(e.target.value)}
          onBlur={saveFillers}
        />
      </label>
      <button
        className="link small"
        onClick={() => set({ fillerWords: [...DEFAULT_FILLER_WORDS] })}
      >
        Reset filler words
      </button>
    </fieldset>
  )
}
