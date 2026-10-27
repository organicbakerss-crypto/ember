/** Registers every IPC request handler. Inputs are validated before they reach the library. */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IPC_EVENT_PREFIX,
  IPC_INVOKE_PREFIX,
  ipcInputs,
  type IpcChannel,
  type IpcEnvelope,
  type IpcEvents,
  type IpcResult,
} from '@shared/ipc'
import type { z } from 'zod'
import type { AppSettingsStore } from './appSettings'
import { confirmFlushed } from './closeGuard'
import { AppError } from './errors'
import type { LibraryHost } from './libraryHost'

type Handlers = {
  [C in IpcChannel]: (
    input: z.output<(typeof ipcInputs)[C]>,
    event: IpcMainInvokeEvent,
  ) => Promise<IpcResult<C>> | IpcResult<C>
}

export function registerIpc(host: LibraryHost, settings: AppSettingsStore): void {
  const handlers: Handlers = {
    'library:status': () => host.status(),
    'library:openDefault': () => host.open(host.defaultPath),
    'library:choose': async (_input, event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a library folder',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'],
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      const path = result.filePaths[0]
      if (result.canceled || !path) throw new AppError('cancelled', 'No folder chosen.')
      return host.open(path)
    },
    'library:snapshot': () => host.current.snapshot(),
    'series:create': (input) => host.current.createSeries(input),
    'series:setWorld': (input) => host.current.setSeriesWorld(input.seriesId, input.worldId),
    'volume:create': (input) => host.current.createVolume(input),
    'outline:get': (input) => host.current.getOutline(input.seriesId, input.volumeId),
    'outline:save': (input) =>
      host.current.saveOutline(input.seriesId, input.volumeId, input.outline),
    'arc:create': (input) => host.current.createArc(input),
    'chapter:create': (input) => host.current.createChapter(input),
    'chapter:read': (input) =>
      host.current.readChapter(input.seriesId, input.volumeId, input.chapterId),
    'chapter:save': (input) =>
      host.current.saveChapter(input.seriesId, input.volumeId, input.chapterId, input.patch),
    'volume:update': (input) =>
      host.current.updateVolume(input.seriesId, input.volumeId, {
        name: input.name,
        goals: input.goals,
      }),
    'volume:stats': (input) => host.current.volumeStats(input.seriesId, input.volumeId),
    'world:create': (input) => host.current.createWorld(input),
    'settings:get': () => settings.read(),
    'settings:update': async (input) => {
      const next = await settings.update(input)
      broadcast('settings:changed', next)
      return next
    },
    'window:flushed': (_input, event) => {
      confirmFlushed(BrowserWindow.fromWebContents(event.sender))
      return null
    },
    'cover:set': (input) => host.current.setCover(input.target, input.data),
    'cover:remove': async (input) => {
      await host.current.removeCover(input.target)
      return null
    },
  }

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(`${IPC_INVOKE_PREFIX}${channel}`, (event, raw) =>
      runHandler(channel, raw, event, handlers),
    )
  }
}

async function runHandler<C extends IpcChannel>(
  channel: C,
  raw: unknown,
  event: IpcMainInvokeEvent,
  handlers: Handlers,
): Promise<IpcEnvelope<IpcResult<C>>> {
  const parsed = ipcInputs[channel].safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: { code: 'invalid-input', message: issue?.message ?? 'Invalid input' },
    }
  }
  try {
    const handler = handlers[channel] as (input: unknown, e: IpcMainInvokeEvent) => unknown
    return { ok: true, value: (await handler(parsed.data, event)) as IpcResult<C> }
  } catch (err) {
    if (err instanceof AppError)
      return { ok: false, error: { code: err.code, message: err.message } }
    console.error(`IPC ${channel} failed:`, err)
    return { ok: false, error: { code: 'internal', message: 'Something went wrong. See the log.' } }
  }
}

/** Sends an event to every open window, so split panes and torn-off windows stay live. */
export function broadcast<E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(`${IPC_EVENT_PREFIX}${event}`, payload)
  }
}
