import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  PAGE_WIDTH,
  PAPER_SIZES,
  STATUS_ITEMS,
  type AnalysisSettings,
  type PaperSize,
} from '@shared/settings'
import { DEFAULT_FILLER_WORDS } from '@shared/analysis/fillers'
import type { IpcResult } from '@shared/ipc'
import { api, describeError } from '../api'
import { STATUS_LABELS } from '../analysisFormat'
import { loadLocal, saveLocal } from '../storage'
import { useSettings } from '../useTheme'
import { SYSTEM_THEME, themes } from '../themes'
import { ExportStyleFields } from '../io/ExportDialog'
import { MOD } from './commands'
import { useOverlays } from './overlays'
import { syncLabel, useSyncStatus } from '../useSync'

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
  { id: 'import', label: 'Import & export', render: () => <ImportExportSettings /> },
  { id: 'sync', label: 'Sync', render: () => <SyncSettings /> },
  { id: 'ai', label: 'AI', render: () => <AiSettingsSection /> },
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
  const plain = [
    { id: SYSTEM_THEME, name: 'Match system (light or dark)' },
    ...themes.filter((t) => !t.skin),
  ]
  const skinned = themes.filter((t) => t.skin).sort((a, b) => a.name.localeCompare(b.name))
  const option = (theme: { id: string; name: string }) => (
    <label key={theme.id} className="radio">
      <input
        type="radio"
        name="theme"
        checked={settings.theme === theme.id}
        onChange={() => update({ theme: theme.id })}
      />
      {theme.name}
    </label>
  )
  return (
    <section className="settings-section">
      <h3>Theme</h3>
      <fieldset className="plain-fieldset">
        <legend className="small muted">Everyday</legend>
        {plain.map(option)}
      </fieldset>
      <fieldset className="plain-fieldset">
        <legend className="small muted">With a world skin</legend>
        <div className="theme-grid">{skinned.map(option)}</div>
      </fieldset>
      <p className="muted small">
        Themes with a world skin also dress World mode: its look, map styling and its own words
        (Settings → World chooses how much). The writing page stays plain and readable in every
        theme.
      </p>
    </section>
  )
}

function ImportExportSettings() {
  const { settings, update } = useSettings()
  return (
    <section className="settings-section">
      <h3>How exports look</h3>
      <p className="muted small">
        Used by every export (Word, PDF, EPUB, Markdown) and by “Copy for Royal Road”. Export from a
        volume’s ⋯ menu, its right-click menu on the series page, a chapter’s right-click menu in
        the binder, or the command palette.
      </p>
      <ExportStyleFields
        headingsLabel="Chapter headings (unless a book has its own)"
        value={settings.export}
        onChange={(patch) =>
          update(({ export: current }) => ({ export: { ...current, ...patch } }))
        }
      />
      <h3>Import</h3>
      <p className="muted small">
        Bring chapters in from a Word file (.docx) with “Import from Word…” on a series page or in a
        volume’s ⋯ menu. You see how it will be split into chapters, and can fix it, before anything
        is created.
      </p>
    </section>
  )
}

/** Connecting to the cloud (Cloudflare R2), and how sync is doing. */
function SyncSettings() {
  const status = useSyncStatus()
  const { toast } = useOverlays()
  const [usage, setUsage] = useState<IpcResult<'sync:usage'>>(null)
  const connected = status?.connected ?? false
  useEffect(() => {
    if (connected) api.invoke('sync:usage').then(setUsage, () => {})
  }, [connected])
  const [token, setToken] = useState('')
  const [manual, setManual] = useState({ url: '', accessKeyId: '', secretAccessKey: '' })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ series: number; worlds: number } | null>(null)
  /** How the last Connect was asked for (repeated when confirming). */
  const [how, setHow] = useState<'token' | 'manual'>('token')
  if (!status) return null
  const device = name || status.device

  const connect = async (via: 'token' | 'manual', confirmed: boolean) => {
    setBusy(true)
    setError(null)
    setHow(via)
    try {
      const r = await api.invoke(
        'sync:connect',
        via === 'token'
          ? { token, device, confirm: confirmed }
          : { ...manual, device, confirm: confirmed },
      )
      if ('confirm' in r) {
        setConfirm(r.confirm)
      } else {
        setConfirm(null)
        setToken('')
        setManual({ url: '', accessKeyId: '', secretAccessKey: '' })
        toast('Connected. Syncing now.')
      }
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setBusy(false)
    }
  }
  const run = async (channel: 'sync:now' | 'sync:disconnect') => {
    setBusy(true)
    try {
      await api.invoke(channel)
    } catch (err) {
      toast(describeError(err).message)
    } finally {
      setBusy(false)
    }
  }

  if (status.connected) {
    const label = syncLabel(status)
    return (
      <section className="settings-section">
        <h3>Sync</h3>
        <p>
          <strong>{label?.text}</strong>
          {status.lastSyncedAt && (
            <span className="muted">
              {' '}
              · last synced {new Date(status.lastSyncedAt).toLocaleString()}
            </span>
          )}
        </p>
        {status.message && (
          <p className={status.state === 'error' ? 'error small' : 'muted small'}>
            {status.message}
          </p>
        )}
        <p className="muted small">
          This computer is “{status.device}”, syncing with the bucket “{status.bucket}”. Changes go
          up about 30 seconds after you stop typing, and the other computer’s changes come down when
          a window comes back into focus, every few minutes, and when the app starts. If a chapter
          changed on both computers, both versions are kept.
        </p>
        <div className="row">
          <button disabled={busy} onClick={() => void run('sync:now')}>
            Sync now
          </button>
          <button disabled={busy} onClick={() => void run('sync:disconnect')}>
            Stop syncing on this computer
          </button>
        </div>
        {usage && (
          <p className="small">
            In the cloud: <strong>{formatBytes(usage.bytes)}</strong>{' '}
            <span className="muted">
              ({usage.files.toLocaleString()} files). Old copies nothing uses are cleared out once
              they’re a month old.
            </span>
          </p>
        )}
        <p className="muted small">
          Stopping keeps every file here and in the cloud; connecting again carries on where it left
          off.
        </p>
      </section>
    )
  }

  const field = (key: keyof typeof manual, label: string, extra: object = {}) => (
    <label>
      {label}
      <input
        value={manual[key]}
        onChange={(e) => setManual((f) => ({ ...f, [key]: e.target.value }))}
        spellCheck={false}
        autoComplete="off"
        {...extra}
      />
    </label>
  )
  return (
    <section className="settings-section sync-settings">
      <h3>Sync</h3>
      <p className="muted small">
        Keep this library the same on your computers, through your own free Cloudflare storage.
        Files stay on each computer; the cloud is only a mailbox between them. Nothing is ever
        replaced: if a chapter changed on both computers, you get both versions.
      </p>
      <ol className="sync-steps">
        <li>
          <button onClick={() => void api.invoke('sync:openCloudflare')}>Open Cloudflare</button>{' '}
          and sign in (or make a free account). It opens on the page for making a key, already
          filled in.
        </li>
        <li>
          Press <strong>Continue to summary</strong>, then <strong>Create Token</strong>, and copy
          the token.
        </li>
        <li>
          <label>
            Paste it here
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="The token from Cloudflare"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </li>
      </ol>
      {error && <p className="error small">{error}</p>}
      {confirm ? (
        <div className="card stack">
          <p>
            The cloud already holds {confirm.series} series
            {confirm.worlds
              ? ` and ${confirm.worlds} ${confirm.worlds === 1 ? 'world' : 'worlds'}`
              : ''}{' '}
            from another computer, and this library has work too. Connecting puts them together:
            everything here goes up, everything there comes down. Nothing is replaced.
          </p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void connect(how, true)}>
              Connect and combine
            </button>
            <button onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div>
          <button
            className="primary"
            disabled={busy || token.trim().length < 20 || !device.trim()}
            onClick={() => void connect('token', false)}
          >
            {busy ? 'Setting up…' : 'Connect'}
          </button>
        </div>
      )}
      <p className="muted small">
        The app makes its own storage space in your Cloudflare account and never touches anything
        else there. On your other computer, paste the same token (keep it in a password manager) and
        everything comes down. The token stays on this computer, in the system’s secure storage when
        it has one.
      </p>
      <label className="sync-name">
        This computer’s name (shown on the other one)
        <input value={device} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </label>
      <details className="sync-guide">
        <summary>Use a storage bucket you set up yourself</summary>
        <p className="muted small">
          For a bucket you made by hand: its S3 API address (from the bucket’s settings, ending with
          its name) and an R2 API token’s Access Key ID and Secret Access Key, with Object Read
          &amp; Write on that bucket.
        </p>
        <div className="stack">
          {field('url', 'S3 API address', {
            placeholder: 'https://….r2.cloudflarestorage.com/my-bucket',
          })}
          {field('accessKeyId', 'Access Key ID')}
          {field('secretAccessKey', 'Secret Access Key', { type: 'password' })}
          <div>
            <button
              disabled={
                busy || !manual.url || !manual.accessKeyId || !manual.secretAccessKey || !device
              }
              onClick={() => void connect('manual', false)}
            >
              Connect to this bucket
            </button>
          </div>
        </div>
      </details>
    </section>
  )
}

/** AI on this computer: on or off, who answers (Ollama or ChatGPT), which model. */
function AiSettingsSection() {
  const { settings, update } = useSettings()
  const { toast } = useOverlays()
  const ai = settings.ai
  const [status, setStatus] = useState<IpcResult<'ai:status'> | null>(null)
  const [host, setHost] = useState(ai.host)
  const [signingIn, setSigningIn] = useState(false)
  // Ask about what's shown (saving it may not have reached the app yet).
  const asked = useRef(0)
  const check = () => {
    const n = ++asked.current
    api.invoke('ai:status', { host: ai.host, provider: ai.provider }).then(
      (s) => n === asked.current && setStatus(s),
      () => {},
    )
  }
  // Check on opening, and again when what's chosen changes.
  useEffect(check, [ai.host, ai.enabled, ai.provider])
  const set = (patch: Partial<typeof ai>) =>
    update(({ ai: current }) => ({ ai: { ...current, ...patch } }))
  const chatgpt = ai.provider === 'chatgpt'

  const signIn = async () => {
    setSigningIn(true)
    try {
      await api.invoke('ai:chatgptSignIn')
      toast('Signed in with ChatGPT.')
    } catch (err) {
      toast(describeError(err).message)
    } finally {
      setSigningIn(false)
      check()
    }
  }
  const signOut = async () => {
    await api.invoke('ai:chatgptSignOut').catch((err) => toast(describeError(err).message))
    check()
  }

  return (
    <section className="settings-section ai-settings">
      <h3>AI</h3>
      <p className="muted small">
        AI helps, it never writes your prose: chat about the story, brainstorm, ask questions about
        your chapters and world, and check spelling and grammar (every change shown first, nothing
        applied until you choose). Off, it leaves no trace in the app.
      </p>
      <label className="radio">
        <input
          type="checkbox"
          checked={ai.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Use AI
      </label>
      {ai.enabled && (
        <>
          <label>
            Answers from
            <select
              value={ai.provider}
              onChange={(e) => {
                setStatus(null)
                set({ provider: e.target.value as typeof ai.provider })
              }}
            >
              <option value="ollama">Ollama (on this computer, free)</option>
              <option value="chatgpt">ChatGPT (your plan)</option>
            </select>
          </label>
          <ul className="muted small ai-notes">
            {chatgpt ? (
              <>
                <li>
                  Uses your ChatGPT plan’s usage. No API key, no extra cost, nothing to install.
                </li>
                <li>
                  Nothing is sent until you ask; then only what the AI panel says it’s reading goes
                  to OpenAI.
                </li>
                <li>Chats are kept only while the app is open.</li>
              </>
            ) : (
              <>
                <li>Runs on this computer: nothing you write leaves it. Works offline.</li>
                <li>Answers depend on the model and your computer’s speed.</li>
              </>
            )}
          </ul>

          <div className="ai-status small" role="status">
            {!status ? (
              <span className="muted">Checking…</span>
            ) : chatgpt ? (
              !status.reachable ? (
                <span className="error">{status.error}</span>
              ) : status.account ? (
                <span>
                  ✓ Signed in with ChatGPT
                  {status.account.email ? ` as ${status.account.email}` : ''}
                  {status.account.plan ? ` (${status.account.plan})` : ''}.
                </span>
              ) : (
                <span>Not signed in yet.</span>
              )
            ) : status.reachable ? (
              status.models.length ? (
                <span>
                  ✓ Ollama is running, with {status.models.length}{' '}
                  {status.models.length === 1 ? 'model' : 'models'}.
                </span>
              ) : (
                <span className="error">
                  Ollama is running but has no models. In a terminal:{' '}
                  <code>ollama pull llama3.2</code>
                </span>
              )
            ) : (
              <span className="error">
                {status.error} Get Ollama from <strong>ollama.com</strong> if it isn’t installed.
              </span>
            )}{' '}
            <button
              className="link small"
              onClick={() => {
                setStatus(null)
                check()
              }}
            >
              Check again
            </button>
          </div>

          {chatgpt && status?.reachable && !status.account && (
            <div>
              <button
                className="primary chatgpt-button"
                disabled={signingIn}
                onClick={() => void signIn()}
              >
                {signingIn ? 'Waiting for the browser…' : 'Continue with ChatGPT'}
              </button>
              {signingIn && (
                <p className="muted small">
                  Finish signing in on the page that opened in your browser, then come back here.
                </p>
              )}
            </div>
          )}
          {chatgpt && status?.account && (
            <div className="row">
              <button onClick={() => void signOut()}>Sign out of ChatGPT</button>
            </div>
          )}

          {(!chatgpt || status?.account) && (
            <label>
              Model
              <select
                value={chatgpt ? ai.chatgptModel : ai.model}
                onChange={(e) =>
                  set(chatgpt ? { chatgptModel: e.target.value } : { model: e.target.value })
                }
              >
                <option value="">
                  {chatgpt ? 'Default' : 'First installed'}
                  {!chatgpt && status?.models[0] ? ` (${status.models[0]})` : ''}
                </option>
                {status?.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!chatgpt && (
            <>
              <p className="muted small">
                Bigger models answer better and slower. A good start on most computers:{' '}
                <code>ollama pull llama3.2</code> (3B); with 16 GB of memory or more, try{' '}
                <code>qwen2.5:14b</code>.
              </p>
              <label>
                Ollama address
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={() => host.trim() && host !== ai.host && set({ host: host.trim() })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && host.trim()) set({ host: host.trim() })
                  }}
                  spellCheck={false}
                />
              </label>
            </>
          )}
          <h3>Where it is</h3>
          <p className="muted small">
            The ✦ AI button on the left of the writing view opens chat, brainstorm and “Ask the
            story”. Spelling and grammar is in the ⋯ menu above the page and the command palette. AI
            settings stay on this computer.
          </p>
        </>
      )}
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

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function LibrarySettings() {
  const [root, setRoot] = useState<string | null>(null)
  const [size, setSize] = useState<IpcResult<'library:size'> | null>(null)
  const { toast } = useOverlays()
  useEffect(() => {
    void api.invoke('library:status').then((s) => setRoot(s.state === 'open' ? s.root : null))
    api.invoke('library:size').then(setSize, () => {})
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
      {size && (
        <div className="library-size">
          <p>
            <strong>{formatBytes(size.total)}</strong> on this computer
          </p>
          <ul className="small muted">
            <li>Writing and world notes: {formatBytes(size.writing)}</li>
            <li>Images (maps, portraits, covers): {formatBytes(size.images)}</li>
            <li>Version history: {formatBytes(size.history)}</li>
            {size.trash > 0 && <li>Trash: {formatBytes(size.trash)}</li>}
            {size.other > 0 && <li>Sync records and other: {formatBytes(size.other)}</li>}
          </ul>
          <p className="muted small">
            A finished book can keep less history: mark it Finished in its ⋯ menu.
          </p>
        </div>
      )}
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
