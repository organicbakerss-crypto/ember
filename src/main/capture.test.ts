import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import type { CaptureContext } from '@shared/ipc'
import { captureMenuItems, setCaptureContext } from './capture'
import type { LibraryHost } from './libraryHost'

const source = {
  seriesId: 'ser_0000000000000000',
  volumeId: 'vol_0000000000000000',
  chapterId: 'chp_0000000000000000',
  chapterTitle: 'Arrival',
}
const context: CaptureContext = {
  worldId: 'wld_0000000000000000',
  source,
  targets: [
    {
      entryId: 'ent_0000000000000000',
      name: 'Mara',
      fields: [{ id: 'appearance', label: 'Appearance' }],
    },
  ],
}

function setup() {
  const sent: unknown[] = []
  const sender = { send: (...args: unknown[]) => sent.push(args) } as unknown as WebContents
  const world = {
    capture: vi.fn(async () => ({})),
    inboxCapture: vi.fn(async () => ({})),
  }
  const host = { current: { world } } as unknown as LibraryHost
  return { sender, host, world, sent }
}

const submenu = (item: MenuItemConstructorOptions | undefined) =>
  (item?.submenu ?? []) as MenuItemConstructorOptions[]

describe('one-click capture menu', () => {
  it('offers nothing without a writing window context or a selection', () => {
    const { sender, host } = setup()
    expect(captureMenuItems(sender, 'Some text', host)).toEqual([])
    setCaptureContext(sender, context)
    expect(captureMenuItems(sender, ' ', host)).toEqual([])
    setCaptureContext(sender, null)
    expect(captureMenuItems(sender, 'Some text', host)).toEqual([])
  })

  it('captures into an entry field, its notes, or the inbox', async () => {
    const { sender, host, world, sent } = setup()
    setCaptureContext(sender, context)
    const [root] = captureMenuItems(sender, '  Her eyes were grey. ', host)
    const [mara, , inbox] = submenu(root)
    expect(mara?.label).toBe('Mara')
    const [appearance, , notes] = submenu(mara)
    appearance?.click?.({} as never, undefined, {} as never)
    notes?.click?.({} as never, undefined, {} as never)
    inbox?.click?.({} as never, undefined, {} as never)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(world.capture).toHaveBeenCalledWith(
      context.worldId,
      'ent_0000000000000000',
      'appearance',
      'Her eyes were grey.',
      source,
    )
    expect(world.capture).toHaveBeenCalledWith(
      context.worldId,
      'ent_0000000000000000',
      null,
      'Her eyes were grey.',
      source,
    )
    expect(world.inboxCapture).toHaveBeenCalledWith(context.worldId, 'Her eyes were grey.', source)
  })
})
