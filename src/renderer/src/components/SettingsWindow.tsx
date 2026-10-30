import { useEffect, useState, type ReactNode } from 'react'
import {
  PAGE_WIDTH,
  PAPER_SIZES,
  STATUS_ITEMS,
  type AnalysisSettings,
  type PaperSize,
} from '@shared/settings'
import { DEFAULT_FILLER_WORDS } from '@shared/analysis/fillers'
import { api, describeError } from '../api'
import { STATUS_LABELS } from '../analysisFormat'
import { loadLocal, saveLocal } from '../storage'
import { useSettings } from '../useTheme'
import { SYSTEM_THEME, themes } from '../themes'
import { MOD } from './commands'
import { useOverlays } from './overlays'

interface Category {
  id: string
  label: string
  /** What it will hold, shown while it isn't built yet. */
  later?: string
  render?: () => ReactNode
}

/** Every settings category the app will have. Ones without settings yet are greyed out. */
const CATEGORIES: Category[] = [
  { id: 'appearance', label: 'Appearance', render: () => <AppearanceSettings /> },
  { id: 'page', label: 'Page', render: () => <PageSettings /> },
  { id: 'spelling', label: 'Spelling', render: () => <SpellingSettings /> },
  { id: 'analysis', label: 'Writing analysis', render: () => <AnalysisSettingsSection /> },
  { id: 'status', label: 'Status bar', render: () => <StatusBarSettings /> },
  { id: 'library', label: 'Library', render: () => <LibrarySettings /> },
  { id: 'shortcuts', label: 'Keyboard shortcuts', later: 'Change the keyboard shortcuts.' },
  { id: 'world', label: 'World', render: () => <WorldSettings /> },
  {
    id: 'import',
    label: 'Import & export',
    later: 'Word import and DOCX, PDF, EPUB, Markdown and Royal Road export (Milestone 6).',
  },
  {
    id: 'sync',
    label: 'Sync',
    later: 'Cloud sync setup and settings sync between devices (Milestones 7–8).',
  },
  {
    id: 'storage',
    label: 'Smart Storage',
    later: 'When unopened volumes and worlds are compressed (Milestone 8).',
  },
  {
    id: 'ai',
    label: 'AI',
    later: 'Ollama and ChatGPT sign-in, per-feature providers (Milestone 10).',
  },
  {
    id: 'companion',
    label: 'Companion',
    later: 'The on-screen companion and character presets (Milestone 11).',
  },
  {
    id: 'voice',
    label: 'Voice',
    later: 'Push-to-talk, local voices and ElevenLabs (Milestone 12).',
  },
  {
    id: 'modules',
    label: 'Optional modules',
    later: "Publishing, author's notes, doodle pad, relationship web (Milestone 14).",
  },
]

/**
 * Settings as a full window in place of the page: categories on the left,
 * their settings on the right. Esc closes it.
 */
export function SettingsWindow(props: { onClose: () => void }) {
  const [current, setCurrent] = useState(() => {
    const saved = loadLocal('settings.category')
    return CATEGORIES.find((c) => c.id === saved && c.render)?.id ?? 'appearance'
  })
  const category = CATEGORIES.find((c) => c.id === current)!

  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings-window" role="dialog" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings categories">
        <h2>Settings</h2>
        <ul>
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <button
                className={`settings-nav-item ${c.id === current ? 'active' : ''}`}
                disabled={!c.render}
                aria-current={c.id === current ? 'page' : undefined}
                title={c.later ? `Coming later: ${c.later}` : undefined}
                onClick={() => {
                  setCurrent(c.id)
                  saveLocal('settings.category', c.id)
                }}
              >
                <span>{c.label}</span>
                {!c.render && <span className="settings-later">Later</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-body">
        <header className="settings-header">
          <h1>{category.label}</h1>
          <button onClick={props.onClose} title="Close settings (Esc)">
            Done
          </button>
        </header>
        {category.render?.()}
      </div>
    </div>
  )
}

function AppearanceSettings() {
  const { settings, update } = useSettings()
  const options = [{ id: SYSTEM_THEME, name: 'Match system (light or dark)' }, ...themes]
  return (
    <section className="settings-section">
      <h3>Theme</h3>
      {options.map((theme) => (
        <label key={theme.id} className="radio">
          <input
            type="radio"
            name="theme"
            checked={settings.theme === theme.id}
            onChange={() => update({ theme: theme.id })}
          />
          {theme.name}
        </label>
      ))}
      <p className="muted small">
        Fantasy, Cyberpunk and Arcade also dress World mode in a skin (its look and its words); the
        writing page stays plain and readable. More themes (’90s Desktop, high contrast and others)
        come in a later milestone.
      </p>
    </section>
  )
}

function PageSettings() {
  const { settings, update: change } = useSettings()
  return (
    <section className="settings-section">
      <h3>Page view</h3>
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
      <label>
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
      <h3>Text width</h3>
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
        {settings.pageWidth === PAGE_WIDTH.default
          ? ' (default, about 60–75 characters a line)'
          : ''}
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
    </section>
  )
}

function SpellingSettings() {
  const { settings, update: change } = useSettings()
  const [languages, setLanguages] = useState<string[]>([])
  const [newWord, setNewWord] = useState('')
  useEffect(() => {
    void api.invoke('spelling:languages').then(setLanguages)
  }, [])
  return (
    <section className="settings-section">
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.spellcheck}
          onChange={(e) => change({ spellcheck: e.target.checked })}
        />
        Check spelling as I type
      </label>
      <p className="muted small">
        Right-click a flagged word for suggestions or to add it to your dictionary.
      </p>
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
      <h3>
        Personal dictionary ({settings.dictionary.length}{' '}
        {settings.dictionary.length === 1 ? 'word' : 'words'})
      </h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const word = newWord.trim()
          if (word && !settings.dictionary.includes(word))
            change({ dictionary: [...settings.dictionary, word].sort() })
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
              onClick={() => change({ dictionary: settings.dictionary.filter((w) => w !== word) })}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusBarSettings() {
  const { settings, update } = useSettings()
  const toggle = (item: (typeof STATUS_ITEMS)[number]) =>
    update(({ statusBar }) => ({
      statusBar: statusBar.includes(item)
        ? statusBar.filter((i) => i !== item)
        : [...statusBar, item],
    }))
  return (
    <section className="settings-section">
      <p className="muted small">
        Choose what the status bar shows. You can also right-click the status bar, and drag its
        items to reorder them.
      </p>
      {STATUS_ITEMS.map((item) => (
        <label key={item} className="radio">
          <input
            type="checkbox"
            checked={settings.statusBar.includes(item)}
            onChange={() => toggle(item)}
          />
          {STATUS_LABELS[item]}
        </label>
      ))}
    </section>
  )
}

function WorldSettings() {
  const { settings, update } = useSettings()
  return (
    <section className="settings-section">
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.linkNames}
          onChange={(e) => update({ linkNames: e.target.checked })}
        />
        Mark names from the world in chapters and entries
      </label>
      <p className="muted small">
        {MOD}click a marked name to open its page. The marks are only shown on screen, never saved
        into the text. When off, names aren’t marked and the side panel still lists them.
      </p>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.hoverCards}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, hoverCards: e.target.checked } }))
          }
        />
        Show a card when hovering a marked name
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.nameCatcher}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, nameCatcher: e.target.checked } }))
          }
        />
        Suggest new names from my chapters (in the world’s inbox, never as a popup)
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.map}
          onChange={(e) => update(({ world }) => ({ world: { ...world, map: e.target.checked } }))}
        />
        Show the map in the Where lens
      </label>
      <p className="muted small">
        When off, Where shows places inside places and a sortable list; maps you made are kept.
      </p>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.lighter}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, lighter: e.target.checked } }))
          }
        />
        Lighter mode for slower computers (smaller map images, no animations)
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.blendLines}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, blendLines: e.target.checked } }))
          }
        />
        On the people board, show every relationship type along a line (otherwise one colour: the
        strongest)
      </label>
      <fieldset className="plain-fieldset">
        <legend>World skin (Fantasy, Cyberpunk and Arcade themes)</legend>
        {(
          [
            ['full', 'Full: art, frames, fonts, map styling and transitions'],
            ['plain', 'Plain: the skin’s fonts and map styling, without art or transitions'],
            ['minimal', 'Minimal: the clean default layout in the theme’s colours'],
          ] as const
        ).map(([level, label]) => (
          <label key={level} className="radio">
            <input
              type="radio"
              name="world-skin"
              checked={settings.world.skin === level}
              onChange={() => update(({ world }) => ({ world: { ...world, skin: level } }))}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.vocabulary}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, vocabulary: e.target.checked } }))
          }
        />
        Themed words in a skin (Atlas, Chronicle, Lore…; otherwise Where, When, How)
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.timeScrubber}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, timeScrubber: e.target.checked } }))
          }
        />
        Show the time scrubber above the map and the board (otherwise the world as it stands at the
        latest chapter)
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={settings.world.trails}
          onChange={(e) =>
            update(({ world }) => ({ world: { ...world, trails: e.target.checked } }))
          }
        />
        Movement trails and animations (portraits glide to where they are; off when reduced motion
        is on)
      </label>
      <label>
        “Gone quiet” after
        <input
          type="number"
          min={1}
          max={200}
          value={settings.world.quietAfter}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value))
            if (n >= 1 && n <= 200) update(({ world }) => ({ world: { ...world, quietAfter: n } }))
          }}
          style={{ width: '5rem' }}
        />{' '}
        chapters without a mention
      </label>
      <label className="radio">
        <input
          type="checkbox"
          checked={!settings.analysis.includeNames}
          onChange={(e) =>
            update(({ analysis }) => ({
              analysis: { ...analysis, includeNames: !e.target.checked },
            }))
          }
        />
        Leave character and place names out of Echo and repeated words
      </label>
      <p className="muted small">
        Templates (which details each kind of entry has) are set per world: World mode → ⋯ →
        Templates. To add a name from a chapter, select it and right-click → “Add to the world…” (
        {MOD}Alt+N). To save a line into the world, select it and right-click → “Capture to the
        world”.
      </p>
    </section>
  )
}

function LibrarySettings() {
  const [root, setRoot] = useState<string | null>(null)
  const { toast } = useOverlays()
  useEffect(() => {
    void api.invoke('library:status').then((s) => setRoot(s.state === 'open' ? s.root : null))
  }, [])
  const choose = async () => {
    try {
      const status = await api.invoke('library:choose')
      if (status.state === 'open') setRoot(status.root)
    } catch (err) {
      const { code, message } = describeError(err)
      if (code !== 'cancelled') toast(message)
    }
  }
  return (
    <section className="settings-section">
      <h3>Library folder</h3>
      <p>
        <code className="path">{root ?? '—'}</code>
      </p>
      <p className="muted small">
        Your series, volumes and worlds are ordinary files in this folder. Choose another folder to
        open (or start) a different library.
      </p>
      <div>
        <button onClick={() => void choose()}>Open a different library…</button>
      </div>
    </section>
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
    <section className="analysis-settings settings-section">
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
    </section>
  )
}
