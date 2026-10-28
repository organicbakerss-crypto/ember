/**
 * App-wide overlays: right-click menus, short notices with an Undo button,
 * and choice dialogs. Views reach them through the hooks at the bottom.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/* ---------- context menu ---------- */

export interface MenuItem {
  label: string
  onSelect?: () => void
  /** Shows a second list instead of acting (e.g. "Move to arc"). */
  submenu?: MenuItem[]
  danger?: boolean
  disabled?: boolean
  /** Shown on the right, e.g. "F3". */
  hint?: string
  /** A tick-box item (shown with ✓ when on). */
  checked?: boolean
  /** Leave the menu open after choosing, to tick several items. */
  keepOpen?: boolean
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  title?: string
}

/* ---------- toast ---------- */

interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void | Promise<unknown> }
}

/* ---------- dialog ---------- */

interface DialogChoice<T extends string> {
  value: T
  label: string
  primary?: boolean
  danger?: boolean
}

interface DialogState {
  title: string
  message?: string
  choices: DialogChoice<string>[]
  resolve: (value: string | null) => void
}

interface Overlays {
  openMenu: (event: { clientX: number; clientY: number }, items: MenuItem[]) => void
  toast: (message: string, action?: Toast['action']) => void
  choose: <T extends string>(
    title: string,
    choices: DialogChoice<T>[],
    message?: string,
  ) => Promise<T | null>
}

const OverlayContext = createContext<Overlays | null>(null)

export function OverlayProvider(props: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const nextToast = useRef(1)

  const openMenu = useCallback<Overlays['openMenu']>((event, items) => {
    setMenu({ x: event.clientX, y: event.clientY, items })
  }, [])

  const toast = useCallback<Overlays['toast']>((message, action) => {
    const id = nextToast.current++
    setToasts((list) => [...list.slice(-2), { id, message, action }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 8000)
  }, [])

  const choose = useCallback<Overlays['choose']>(
    (title, choices, message) =>
      new Promise((resolve) =>
        setDialog({
          title,
          message,
          choices,
          resolve: resolve as (value: string | null) => void,
        }),
      ),
    [],
  )

  const closeDialog = (value: string | null) => {
    dialog?.resolve(value)
    setDialog(null)
  }

  return (
    <OverlayContext.Provider value={{ openMenu, toast, choose }}>
      {props.children}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {dialog && <Dialog state={dialog} onClose={closeDialog} />}
      {toasts.length > 0 && (
        <div className="toasts" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span>{t.message}</span>
              {t.action && (
                <button
                  className="link"
                  onClick={() => {
                    setToasts((list) => list.filter((x) => x.id !== t.id))
                    void t.action!.run()
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </OverlayContext.Provider>
  )
}

export function useOverlays(): Overlays {
  const overlays = useContext(OverlayContext)
  if (!overlays) throw new Error('useOverlays outside OverlayProvider')
  return overlays
}

/** `onContextMenu` handler that opens a menu with these items. */
export function useContextMenu(items: () => MenuItem[]) {
  const { openMenu } = useOverlays()
  return (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    openMenu(event, items())
  }
}

function ContextMenu(props: { state: MenuState; onClose: () => void }) {
  const [items, setItems] = useState(props.state.items)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ x: props.state.x, y: props.state.y })
  const ref = useRef<HTMLDivElement>(null)

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPos({
      x: Math.min(props.state.x, window.innerWidth - box.width - 8),
      y: Math.min(props.state.y, window.innerHeight - box.height - 8),
    })
  }, [props.state, items])

  useEffect(() => {
    ref.current?.focus()
    const close = (e: Event) => {
      if (e.type === 'blur' || !ref.current?.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', props.onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', props.onClose)
    }
  }, [props])

  const run = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return
    if (item.submenu) {
      setItems(item.submenu)
      setActive(0)
      return
    }
    if (item.keepOpen) {
      item.onSelect?.()
      setItems((list) => list.map((x) => (x === item ? { ...x, checked: !x.checked } : x)))
      return
    }
    props.onClose()
    item.onSelect?.()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
        else if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length)
        else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length)
        else if (e.key === 'Enter' || e.key === 'ArrowRight') run(items[active])
        else if (e.key === 'ArrowLeft') setItems(props.state.items)
        else return
        e.preventDefault()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked}
          aria-haspopup={item.submenu ? 'menu' : undefined}
          aria-keyshortcuts={item.hint}
          className={`menu-item ${i === active ? 'active' : ''} ${item.danger ? 'danger' : ''}`}
          disabled={item.disabled}
          onMouseEnter={() => setActive(i)}
          onClick={() => run(item)}
        >
          <span>
            {item.checked !== undefined && (
              <span className="menu-check" aria-hidden>
                {item.checked ? '✓' : ''}
              </span>
            )}
            {item.label}
          </span>
          {item.submenu ? (
            <span className="muted" aria-hidden>
              ▸
            </span>
          ) : (
            item.hint && (
              <span className="muted small" aria-hidden>
                {item.hint}
              </span>
            )
          )}
        </button>
      ))}
    </div>
  )
}

function Dialog(props: { state: DialogState; onClose: (value: string | null) => void }) {
  const { state } = props
  return (
    <div className="modal-backdrop" onMouseDown={() => props.onClose(null)}>
      <div
        className="card stack dialog"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose(null)}
      >
        <h3>{state.title}</h3>
        {state.message && <p className="muted">{state.message}</p>}
        <div className="dialog-choices">
          {state.choices.map((choice) => (
            <button
              key={choice.value}
              autoFocus={choice.primary}
              className={choice.primary ? 'primary' : choice.danger ? 'danger' : ''}
              onClick={() => props.onClose(choice.value)}
            >
              {choice.label}
            </button>
          ))}
          <button onClick={() => props.onClose(null)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
