/** Registers every IPC request handler. Inputs are validated before they reach the library. */
import { BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
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
import { applySpelling } from './spelling'
import { setCaptureContext } from './capture'
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
    'series:rename': (input) => host.current.renameSeries(input.seriesId, input.name),
    'world:rename': (input) => host.current.renameWorld(input.worldId, input.name),
    'arc:delete': (input) =>
      host.current.deleteArc(input.seriesId, input.volumeId, input.arcId, input.chapters),
    'history:list': (input) =>
      host.current.listSnapshots(input.seriesId, input.volumeId, input.chapterId),
    'history:read': (input) =>
      host.current.readSnapshot(input.seriesId, input.volumeId, input.chapterId, input.snapshotId),
    'history:keep': async (input) => {
      await host.current.keepSnapshot(input.seriesId, input.volumeId, input.chapterId)
      return null
    },
    'history:restore': (input) =>
      host.current.restoreSnapshot(
        input.seriesId,
        input.volumeId,
        input.chapterId,
        input.snapshotId,
      ),
    'search:volume': (input) =>
      host.current.searchVolume(input.seriesId, input.volumeId, input.query, input),
    'search:replaceAll': (input) =>
      host.current.replaceAllInVolume(
        input.seriesId,
        input.volumeId,
        input.query,
        input.replacement,
        input,
      ),
    'spelling:languages': () => session.defaultSession.availableSpellCheckerLanguages,
    'world:get': (input) => host.current.world.view(input.worldId),
    'world:index': (input) => host.current.world.index(input.worldId),
    'world:digest': (input) => host.current.world.digest(input.worldId),
    'world:pin': (input) => host.current.world.pin(input.worldId, input.entryId, input.pinned),
    'template:save': (input) => host.current.world.saveTemplate(input.worldId, input.template),
    'template:delete': async (input) => {
      await host.current.world.deleteTemplate(input.worldId, input.templateId)
      return null
    },
    'entry:create': (input) => host.current.world.createEntry(input.worldId, input),
    'entry:read': (input) => host.current.world.readEntry(input.worldId, input.entryId),
    'entry:save': (input) =>
      host.current.world.saveEntry(input.worldId, input.entryId, input.patch),
    'entry:appearances': (input) => host.current.world.appearances(input.worldId, input.entryId),
    'entry:text': (input) => host.current.world.entryText(input.worldId, input.entryId),
    'entry:duplicate': (input) => host.current.world.duplicate(input.worldId, input.entryId),
    'entry:merge': (input) => host.current.world.merge(input.worldId, input.keepId, input.mergeId),
    'entry:delete': (input) =>
      host.current.world.deleteEntry(input.worldId, input.entryId, input.unlink),
    'entry:portrait': (input) =>
      host.current.world.setPortrait(input.worldId, input.entryId, input.data),
    'entry:capture': (input) =>
      host.current.world.capture(
        input.worldId,
        input.entryId,
        input.field,
        input.text,
        input.source,
      ),
    'inbox:get': (input) => host.current.world.inbox(input.worldId, input.names),
    'inbox:capture': (input) =>
      host.current.world.inboxCapture(input.worldId, input.text, input.source),
    'inbox:file': (input) =>
      host.current.world.inboxFile(input.worldId, input.itemId, input.entryId, input.field),
    'inbox:dismiss': (input) => host.current.world.inboxDismiss(input.worldId, input.itemId),
    'names:reject': async (input) => {
      await host.current.world.rejectNames(input.worldId, input.names, input.rejected)
      return null
    },
    'map:create': (input) => host.current.world.createMap(input.worldId, input),
    'map:save': (input) => host.current.world.saveMap(input.worldId, input.mapId, input.patch),
    'capture:context': (input, event) => {
      setCaptureContext(event.sender, input.context)
      return null
    },
    'trash:add': (input) => host.current.moveToTrash(input.target),
    'trash:list': () => host.current.listTrash(),
    'trash:restore': (input) => host.current.restoreFromTrash(input.trashId),
    'trash:purge': async (input) => {
      await host.current.purgeTrash(input.trashId)
      return null
    },
    'trash:empty': async () => {
      await host.current.emptyTrash()
      return null
    },
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
    'volume:texts': (input) => host.current.volumeTexts(input.seriesId, input.volumeId),
    'volume:names': (input) => host.current.volumeNames(input.seriesId),
    'world:create': (input) => host.current.createWorld(input),
    'settings:get': () => settings.read(),
    'settings:update': async (input) => {
      const previous = await settings.read()
      const next = await settings.update(input)
      applySpelling(session.defaultSession, next, previous)
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
