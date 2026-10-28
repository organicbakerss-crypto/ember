import { useEffect, useMemo, useRef, useState } from 'react'
import type { Template } from '@shared/schema'
import { LENSES } from '@shared/world/lenses'
import { LENS_LABELS, type Lens } from '@shared/world/templates'

/**
 * Picks a template, in the app's own style (not a system dropdown). Type to
 * search. With `lens`, only that lens's templates are listed, plus
 * "Something else…" to show them all.
 */
export function TemplatePicker(props: {
  templates: Template[]
  value: string
  onChange: (templateId: string) => void
  lens?: Lens
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(!props.lens)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const current = props.templates.find((t) => t.id === props.value)

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const lenses = all || q ? LENSES : LENSES.filter((l) => l === props.lens)
    return lenses.flatMap((lens) =>
      props.templates
        .filter((t) => t.lens === lens && (!q || t.name.toLowerCase().includes(q)))
        .map((t) => ({ lens, template: t })),
    )
  }, [props.templates, props.lens, all, q])
  const offerMore = !all && !q && !!props.lens
  const count = shown.length + (offerMore ? 1 : 0)
  const safeActive = Math.min(active, Math.max(0, count - 1))

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [safeActive, open])

  const choose = (i: number) => {
    const item = shown[i]
    if (item) {
      props.onChange(item.template.id)
      setOpen(false)
      setQuery('')
    } else if (offerMore) {
      setAll(true)
      setActive(0)
    }
  }
  const openWith = (text = '') => {
    setOpen(true)
    setQuery(text)
    const index = shown.findIndex((s) => s.template.id === props.value)
    setActive(text ? 0 : Math.max(0, index))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') openWith()
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) openWith(e.key)
      else return
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowDown') setActive((a) => Math.min(count - 1, a + 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
    else if (e.key === 'Enter') choose(safeActive)
    else if (e.key === 'Escape') setOpen(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="template-picker" ref={box}>
      {open ? (
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-label={props.label}
          aria-controls="template-picker-list"
          placeholder={current?.name ?? 'Search templates'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <button
          type="button"
          className="template-picker-button"
          role="combobox"
          aria-expanded={false}
          aria-label={props.label}
          onClick={() => openWith()}
          onKeyDown={onKeyDown}
        >
          <span>{current?.name ?? 'Choose…'}</span>
          {current && <span className="muted small">{LENS_LABELS[current.lens]}</span>}
          <span aria-hidden className="template-picker-caret">
            ▾
          </span>
        </button>
      )}
      {open && (
        <ul ref={list} id="template-picker-list" role="listbox" className="template-picker-list">
          {shown.map(({ lens, template }, i) => {
            const heading = (all || !!q) && (i === 0 || shown[i - 1]!.lens !== lens)
            return (
              <li key={template.id} role="presentation">
                {heading && <div className="template-picker-group small">{LENS_LABELS[lens]}</div>}
                <div
                  role="option"
                  aria-selected={template.id === props.value}
                  className={`template-picker-option ${i === safeActive ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(i)
                  }}
                >
                  {template.name}
                  {template.id === props.value && <span aria-hidden>✓</span>}
                </div>
              </li>
            )
          })}
          {offerMore && (
            <li role="presentation">
              <div
                role="option"
                aria-selected={false}
                className={`template-picker-option more ${safeActive === shown.length ? 'active' : ''}`}
                onMouseEnter={() => setActive(shown.length)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(shown.length)
                }}
              >
                Something else…
              </div>
            </li>
          )}
          {count === 0 && <li className="muted small template-picker-group">No match</li>}
        </ul>
      )}
    </div>
  )
}
