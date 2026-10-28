/**
 * One-click capture: select a sentence in a chapter, right-click, "Add to
 * Mara → Appearance". The writing window tells main which entries it can
 * capture into (the ones in the open chapter); main does the saving.
 */
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { IPC_EVENT_PREFIX, type CaptureContext } from '@shared/ipc'
import type { LibraryHost } from './libraryHost'

const contexts = new WeakMap<WebContents, CaptureContext>()

/** At most this many entries in the menu (the rest are reachable from the side panel). */
const MAX_TARGETS = 12

export function setCaptureContext(sender: WebContents, context: CaptureContext | null): void {
  if (context) contexts.set(sender, context)
  else contexts.delete(sender)
}

/** Menu items for capturing the selected text, or none when there is nothing to capture into. */
export function captureMenuItems(
  sender: WebContents,
  selection: string,
  host: LibraryHost,
): MenuItemConstructorOptions[] {
  const context = contexts.get(sender)
  const text = selection.trim()
  if (!context || text.length < 2 || text.length > 5000) return []
  const { worldId, source } = context
  const done = (message: string) => sender.send(`${IPC_EVENT_PREFIX}text:captured`, message)
  const fail = (err: unknown) =>
    done(`Couldn’t capture that: ${err instanceof Error ? err.message : 'unknown error'}`)
  const toEntry = (entryId: string, name: string, field: string | null, label: string) => () =>
    Promise.resolve()
      .then(() => host.current.world.capture(worldId, entryId, field, text, source))
      .then(() => done(`Saved to ${name} → ${label}.`), fail)

  const targets: MenuItemConstructorOptions[] = context.targets.slice(0, MAX_TARGETS).map((t) => ({
    label: t.name,
    submenu: [
      ...t.fields.map((f) => ({
        label: f.label,
        click: toEntry(t.entryId, t.name, f.id, f.label),
      })),
      { type: 'separator' as const },
      { label: 'Notes', click: toEntry(t.entryId, t.name, null, 'Notes') },
    ],
  }))
  return [
    {
      label: 'Capture to the world',
      submenu: [
        ...targets,
        ...(targets.length ? [{ type: 'separator' as const }] : []),
        {
          label: 'Capture to the inbox',
          click: () =>
            Promise.resolve()
              .then(() => host.current.world.inboxCapture(worldId, text, source))
              .then(() => done('Saved to the world’s inbox.'), fail),
        },
      ],
    },
  ]
}
