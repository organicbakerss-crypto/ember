/**
 * The command palette (Ctrl/Cmd+K). Views register the commands that make
 * sense where they are; the palette lists whatever is registered right now.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export interface Command {
  id: string
  title: string
  /** Shown before the title, e.g. "Go to chapter". */
  group?: string
  shortcut?: string
  run: () => void
}

interface Registry {
  set: (owner: string, commands: Command[]) => void
  remove: (owner: string) => void
}

const RegistryContext = createContext<Registry | null>(null)

const isMac = navigator.platform.toLowerCase().includes('mac')
export const MOD = isMac ? '⌘' : 'Ctrl+'

/** True for Ctrl (Windows/Linux) or Cmd (macOS) shortcuts. */
export function modKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

export function CommandProvider(props: { children: ReactNode }) {
  const [sets, setSets] = useState<Record<string, Command[]>>({})
  const [open, setOpen] = useState(false)
  const registry = useMemo<Registry>(
    () => ({
      set: (owner, commands) => setSets((s) => ({ ...s, [owner]: commands })),
      remove: (owner) =>
        setSets((s) => {
          const next = { ...s }
          delete next[owner]
          return next
        }),
    }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modKey(e) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Later registrations (deeper views) come first.
  const commands = Object.values(sets).reverse().flat()

  return (
    <RegistryContext.Provider value={registry}>
      {props.children}
      {open && <Palette commands={commands} onClose={() => setOpen(false)} />}
    </RegistryContext.Provider>
  )
}

/** Registers commands while the calling component is shown. */
export function useCommands(owner: string, commands: Command[]): void {
  const registry = useContext(RegistryContext)
  const latest = useRef(commands)
  useEffect(() => {
    latest.current = commands
  })
  // Re-register when the list's shape changes; `run` always calls the latest handler.
  const signature = commands.map((c) => `${c.id}|${c.title}|${c.group ?? ''}`).join('\n')
  useEffect(() => {
    if (!registry) return
    registry.set(
      owner,
      latest.current.map((c) => ({
        ...c,
        run: () => latest.current.find((x) => x.id === c.id)?.run(),
      })),
    )
  }, [registry, owner, signature])
  useEffect(() => () => registry?.remove(owner), [registry, owner])
}

function Palette(props: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLOListElement>(null)

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return props.commands
      .filter((c) => {
        const text = `${c.group ?? ''} ${c.title}`.toLowerCase()
        return words.every((w) => text.includes(w))
      })
      .slice(0, 50)
  }, [props.commands, query])

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (command: Command | undefined) => {
    if (!command) return
    props.onClose()
    command.run()
  }

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={props.onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          aria-label="Type a command"
          placeholder="Type a command or a chapter name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose()
            else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, matches.length - 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
            else if (e.key === 'Enter') run(matches[active])
            else return
            e.preventDefault()
          }}
        />
        <ol ref={list} className="palette-list" role="listbox">
          {matches.map((c, i) => (
            <li key={c.id}>
              <button
                role="option"
                aria-selected={i === active}
                className={`palette-item ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span>
                  {c.group && <span className="muted">{c.group}: </span>}
                  {c.title}
                </span>
                {c.shortcut && <kbd className="muted small">{c.shortcut}</kbd>}
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="muted small palette-empty">No matching commands.</li>
          )}
        </ol>
      </div>
    </div>
  )
}
