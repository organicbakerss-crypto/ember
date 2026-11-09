/** Registers every IPC request handler. Inputs are validated before they reach the library. */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  webContents,
  type IpcMainInvokeEvent,
} from 'electron'
import { tokenPageUrl } from './sync/cloudflare'
import type { DocLeases } from './docLeases'
import { copyForRoyalRoad, exportVolume, exportWorldPdf } from './export/service'
import { readDocx } from './import/docx'
import type { WindowManager } from './windows'
import {
  IPC_EVENT_PREFIX,
  IPC_INVOKE_PREFIX,
  ipcInputs,
  type IpcChannel,
  type IpcEnvelope,
  type IpcEvents,
  type IpcResult,
  type LibraryChange,
} from '@shared/ipc'
import type { z } from 'zod'
import type { AppSettingsStore } from './appSettings'
import { confirmFlushed } from './closeGuard'
import { listBackups, type BackupService } from './backup'
import { applySpelling } from './spelling'
import { writeFileAtomic } from './fs/atomicWrite'
import { join } from 'node:path'
import { setCaptureContext } from './capture'
import { AppError } from './errors'
import type { LibraryHost } from './libraryHost'
import type { SyncService } from './sync/service'
import type { AiService } from './ai/service'
import { AiJobs } from './ai/jobs'
import { Attachments } from './ai/attachments'
import { RoundtableRunner } from './ai/roundtableRunner'
import { AutoWorld } from './ai/autoWorld'
import { docBlocks, segments } from '@shared/voice/script'
import type { VoiceService } from './voice/service'

type Handlers = {
  [C in IpcChannel]: (
    input: z.output<(typeof ipcInputs)[C]>,
    event: IpcMainInvokeEvent,
  ) => Promise<IpcResult<C>> | IpcResult<C>
}

export function registerIpc(
  host: LibraryHost,
  settings: AppSettingsStore,
  windows: { manager: WindowManager; leases: DocLeases },
  sync: SyncService,
  ai: AiService,
  voice: VoiceService,
  backup: BackupService,
): { libraryChanged: (change: LibraryChange) => void } {
  const { manager, leases } = windows
  // Asking the other windows what they show (for a torn-off AI window).
  // Roundtable continues in the main process if the AI tab is closed or hidden.
  const roundtable = new RoundtableRunner(host, ai, (status) =>
    broadcast('ai:roundtableStatus', status),
  )
  const attachments = new Attachments(() => join(host.current.paths.localDir, 'ai-attachments'))
  const scopeAsks = new Map<string, (scope: IpcResult<'ai:scope'>) => void>()
  let scopeAskId = 0
  // AI work runs here, apart from the window that asked (it keeps going if that pane closes).
  const jobs = new AiJobs({
    token: (requestId, text) => broadcast('ai:token', { requestId, text }),
    progress: (requestId, text) => broadcast('ai:progress', { requestId, text }),
    changed: (job) => {
      broadcast('ai:job', job)
      if (job.state === 'running') return
      // Tell the window that asked (or any, if it's gone) that it's finished.
      const target = webContents.fromId(job.origin) ?? BrowserWindow.getAllWindows()[0]?.webContents
      if (target && !target.isDestroyed()) {
        target.send(`${IPC_EVENT_PREFIX}ai:jobDone`, job)
      }
    },
  })
  /** Reads a chapter for the world, as a background job (`auto`: started by itself). */
  const updateWorld = async (
    input: { requestId: string; seriesId: string; volumeId: string; chapterId: string },
    origin: number,
    auto: boolean,
  ) =>
    jobs.run(
      {
        id: input.requestId,
        kind: 'world',
        seriesId: input.seriesId,
        conversation: null,
        volumeId: input.volumeId,
        chapterId: input.chapterId,
        chapterTitle:
          (
            await host.current
              .readChapter(input.seriesId, input.volumeId, input.chapterId)
              .catch(() => null)
          )?.title ?? '',
        sent: null,
        origin,
        auto,
      },
      async (_onToken, onProgress) => {
        const result = await ai.updateWorld(input, onProgress)
        // Adaptive story characters pick up what happened to them in this chapter.
        void ai.learnFromChapter(input).catch(() => {})
        return result
      },
    )
  // Keeping the world up to date by itself, when that's switched on.
  const auto = new AutoWorld({
    settings: async () => (await settings.read()).ai,
    host,
    run: (ref) =>
      updateWorld(
        { ...ref, requestId: `auto-${Date.now()}` },
        BrowserWindow.getAllWindows()[0]?.webContents.id ?? 0,
        true,
      ),
  })
  auto.start()

  const handlers: Handlers = {
    'ai:scope': (input, event) =>
      new Promise((resolve) => {
        const requestId = `scope-${++scopeAskId}`
        const done = (scope: IpcResult<'ai:scope'>) => {
          scopeAsks.delete(requestId)
          resolve(scope)
        }
        scopeAsks.set(requestId, (scope) => scope && done(scope))
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.isDestroyed() || w.webContents === event.sender) continue
          w.webContents.send(`${IPC_EVENT_PREFIX}ai:scopeRequest`, {
            requestId,
            seriesId: input.seriesId,
          })
        }
        setTimeout(() => scopeAsks.has(requestId) && done(null), 1000)
      }),
    'ai:scopeReply': (input) => {
      scopeAsks.get(input.requestId)?.(input.scope)
      return null
    },
    'export:volume': async (input, event) =>
      exportVolume(host.current, BrowserWindow.fromWebContents(event.sender), {
        ...input,
        settings: (await settings.read()).export,
      }),
    'export:royalRoad': async (input) =>
      copyForRoyalRoad(host.current, { ...input, settings: (await settings.read()).export }),
    'import:docx': (_input, event) => readDocx(BrowserWindow.fromWebContents(event.sender)),
    'ai:status': (input) => ai.status(input),
    'ai:roundtableRun': async (input) => {
      const file = await host.current.readConversation(input.seriesId, input.conversationId)
      if (!file.roundtable) throw new AppError('invalid-input', 'This is not a Roundtable session.')
      return roundtable.start(input.seriesId, input.conversationId)
    },
    'ai:roundtablePause': (input) => roundtable.pause(input.seriesId, input.conversationId),
    'ai:roundtableStatus': (input) => roundtable.status(input.seriesId, input.conversationId),
    'ai:roundtablePrivate': (input) => ai.roundtablePrivate(input),
    'ai:roundtableTurn': (input) => ai.roundtableTurn(input),
    'ai:secondOpinion': async (input) =>
      ai.ask(
        {
          ...input,
          attachments:
            input.conversationId && input.attachmentIds?.length
              ? await attachments.texts(input.conversationId, input.attachmentIds)
              : [],
        },
        () => {},
        (text) => broadcast('ai:progress', { requestId: input.requestId, text }),
      ),
    'ai:attach': (input) => attachments.add(input.conversationId, input.name, input.data),
    'character:list': (input) => host.current.world.listCharacters(input.worldId),
    'character:save': (input) => host.current.world.saveCharacter(input.worldId, input.character),
    'character:delete': (input) =>
      host.current.world.deleteCharacter(input.worldId, input.characterId),
    'character:make': (input) => ai.makeCharacter(input),
    'ai:attachmentsHere': (input) => attachments.here(input.conversationId, input.ids),
    'ai:ask': async (input, event) => {
      // Saved now, so the question is kept whatever happens; again with the answer.
      await host.current.saveConversation(input.seriesId, input.conversation)
      return jobs.run(
        {
          id: input.requestId,
          kind: 'ask',
          seriesId: input.seriesId,
          conversation: input.conversation,
          volumeId: input.scope?.volumeId ?? null,
          chapterId: input.scope?.chapterId ?? null,
          chapterTitle: '',
          sent: null,
          origin: event.sender.id,
        },
        async (onToken, onProgress) =>
          ai.ask(
            {
              ...input,
              characterId: input.conversation.characterId,
              attachments: input.attachmentIds?.length
                ? await attachments.texts(input.conversation.id, input.attachmentIds)
                : [],
            },
            onToken,
            onProgress,
          ),
        async (job, outcome) => {
          if (!job.text) return
          // Adaptive characters pick up lasting views from the writer's message (when on).
          const said = [...input.messages].reverse().find((m) => m.role === 'user')?.content
          if (said) void ai.learn(said).catch(() => {})
          const now = new Date().toISOString()
          const looked = outcome.value?.lookedAt ?? []
          await host.current.saveConversation(input.seriesId, {
            ...input.conversation,
            updatedAt: now,
            messages: [
              ...input.conversation.messages,
              {
                role: 'assistant',
                content: job.text,
                at: now,
                read: looked.length ? looked.join(', ') : null,
              },
            ],
          })
        },
      )
    },
    'ai:editChapter': async (input, event) => {
      await host.current.saveConversation(input.seriesId, input.conversation)
      return jobs.run(
        {
          id: input.requestId,
          kind: 'edit',
          seriesId: input.seriesId,
          conversation: input.conversation,
          volumeId: input.volumeId,
          chapterId: input.chapterId,
          chapterTitle: input.chapterTitle,
          sent: input.chapter,
          origin: event.sender.id,
        },
        (onToken) => ai.editChapter(input, onToken),
      )
    },
    'ai:updateWorld': (input, event) => updateWorld(input, event.sender.id, false),
    'ai:sortNames': (input, event) =>
      jobs.run(
        {
          id: input.requestId,
          kind: 'names',
          seriesId: input.seriesId,
          conversation: null,
          volumeId: null,
          chapterId: null,
          chapterTitle: '',
          sent: null,
          origin: event.sender.id,
        },
        (_onToken, onProgress) => ai.sortNames(input, onProgress),
      ),
    'voice:script': (input, event) =>
      jobs.run(
        {
          id: input.requestId,
          kind: 'voices',
          seriesId: input.seriesId,
          conversation: null,
          volumeId: input.volumeId,
          chapterId: input.chapterId,
          chapterTitle: '',
          sent: null,
          origin: event.sender.id,
        },
        async (_onToken, onProgress) => {
          const made = await ai.voiceScript(input, onProgress)
          onProgress('')
          const window = BrowserWindow.fromWebContents(event.sender)
          const options: Electron.SaveDialogOptions = {
            title: 'Save the audiobook script',
            defaultPath: join(
              app.getPath('documents'),
              `${made.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Story'} - audiobook script.txt`,
            ),
            filters: [{ name: 'Text', extensions: ['txt'] }],
          }
          const choice =
            window && !window.isDestroyed()
              ? await dialog.showSaveDialog(window, options)
              : await dialog.showSaveDialog(options)
          let saved: string | null = null
          if (!choice.canceled && choice.filePath) {
            await writeFileAtomic(choice.filePath, made.script)
            saved = choice.filePath
          }
          return {
            summary: '',
            applied: 0,
            suggestions: 0,
            saved,
            chapters: made.chapters,
            lines: made.lines,
          }
        },
      ) as Promise<{ saved: string | null; chapters: number; lines: number }>,
    'voice:status': () => voice.status(),
    'voice:speak': (input) => voice.speak(input),
    'voice:transcribe': async (input) => {
      let names: string[] = []
      if (input.seriesId) {
        const series = await host.current.getSeries(input.seriesId).catch(() => null)
        if (series?.worldId) {
          const view = await host.current.world.view(series.worldId).catch(() => null)
          names = view ? view.entries.flatMap((e) => [e.name, ...e.aliases]) : []
        }
      }
      return voice.transcribe(input.audio, input.mime, names)
    },
    'ai:chapterSynopsis': (input) => ai.chapterSynopsis(input),
    'voice:chapterSpeakers': (input, event) =>
      ai.chapterSpeakers(input, (text) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(`${IPC_EVENT_PREFIX}ai:progress`, { requestId: input.requestId, text })
        }
      }),
    'voice:lines': async (input, event) => {
      const who = await ai.chapterSpeakers(input, (text) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(`${IPC_EVENT_PREFIX}ai:progress`, { requestId: input.requestId, text })
        }
      })
      const lib = host.current
      const chapter = await lib.readChapter(input.seriesId, input.volumeId, input.chapterId)
      const file = await lib.readSpeakers(input.seriesId, input.volumeId, input.chapterId)
      const segs = segments(docBlocks(chapter.content))
      const lines: IpcResult<'voice:lines'>['lines'] = []
      const seen = new Set<string>()
      segs.forEach((seg, i) => {
        if (seg.kind !== 'quote' || !seg.key || seen.has(seg.key)) return
        seen.add(seg.key)
        // The narration just before, for context ("she said").
        const prev = segs[i - 1]
        lines.push({
          key: seg.key,
          text: seg.text,
          before: prev && prev.kind === 'narration' ? prev.text.slice(-120) : '',
          speaker: who.lines[seg.key] ?? null,
          fixed: !!file?.fixed[seg.key],
        })
      })
      return { narrator: who.narrator, lines }
    },
    'voice:fixLine': async (input) => {
      const lib = host.current
      const series = await lib.getSeries(input.seriesId)
      const entries = series.worldId ? (await lib.world.view(series.worldId)).entries : []
      const entry = entries.find((e) => e.name === input.name)
      await lib.fixSpeaker(input.seriesId, input.volumeId, input.chapterId, input.key, {
        entryId: entry?.id ?? null,
        name: input.name,
      })
      return null
    },
    'voice:setCast': async (input) => {
      await host.current.setSeriesVoices(input.seriesId, input.voices)
      return null
    },
    'voice:cast': async (input) => {
      const v = (await host.current.getSeries(input.seriesId)).voices
      return {
        narrator: v?.narrator ?? '',
        other: v?.other ?? '',
        characters: v?.characters ?? {},
      }
    },
    'ai:jobs': (input) => jobs.list(input.seriesId),
    'ai:jobSeen': (input) => {
      jobs.seen(input.id)
      return null
    },
    'ai:summaries': async (input) =>
      (await host.current.storySummaries(input.seriesId)).map((s) => ({
        chapter: s.chapter,
        summary: s.summary,
        current: s.current,
        words: s.paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
      })),
    'ai:conversations': (input) => host.current.listConversations(input.seriesId),
    'ai:conversation': (input) =>
      host.current.readConversation(input.seriesId, input.conversationId),
    'ai:saveConversation': async (input) => {
      await host.current.saveConversation(input.seriesId, input.conversation)
      return null
    },
    'ai:deleteConversation': async (input) => {
      await host.current.deleteConversation(input.seriesId, input.conversationId)
      return null
    },
    'ai:chatgptSignIn': async () => {
      await ai.chatgptSignIn((url) => shell.openExternal(url))
      return null
    },
    'ai:chatgptSignOut': async () => {
      await ai.chatgptSignOut()
      return null
    },
    'ai:cancel': (input) => {
      ai.cancel(input.requestId)
      return null
    },
    'sync:status': () => sync.status(),
    'sync:connect': (input) => sync.connect(input),
    'sync:disconnect': () => sync.disconnect(),
    'sync:openCloudflare': async () => {
      await shell.openExternal(tokenPageUrl())
      return null
    },
    'sync:now': () => sync.syncNow(),
    'sync:conflicts': () => sync.conflicts(),
    'sync:conflictRestore': async (input) => {
      await sync.restoreConflict(input.id)
      return null
    },
    'sync:conflictDelete': async (input) => {
      await sync.deleteConflict(input.id)
      return null
    },
    'history:fetchCloud': async (input) => ({
      added: await sync.fetchHistory(input.volumeId, input.chapterId),
    }),
    'import:chapters': async (input) => {
      // One after another, so they keep their order at the end of the volume.
      for (const c of input.chapters) {
        const created = await host.current.createChapter({
          seriesId: input.seriesId,
          volumeId: input.volumeId,
          title: c.title,
          type: c.type,
        })
        await host.current.saveChapter(input.seriesId, input.volumeId, created.id, {
          content: c.content,
        })
      }
      return { created: input.chapters.length }
    },
    'window:open': (input, event) => {
      const from = BrowserWindow.fromWebContents(event.sender)
      manager.openPane(input.route, input.atCursor ? manager.boundsAtCursor(from) : null, from)
      return null
    },
    'window:dropped': (input, event) =>
      manager.droppedOutside(BrowserWindow.fromWebContents(event.sender), input.route),
    'window:dock': (input, event) => {
      manager.dock(BrowserWindow.fromWebContents(event.sender), input.route, input.keep ?? false)
      return null
    },
    'window:route': (input, event) => {
      manager.setRoute(BrowserWindow.fromWebContents(event.sender), input.route)
      return null
    },
    'window:showEntry': (input) => manager.showEntry(input.worldId, input.entryId),
    'doc:claim': (input, event) => leases.claim(input.key, event.sender, input.pane, input.take),
    'doc:release': (input, event) => {
      leases.release(input.key, event.sender, input.pane)
      return null
    },
    'doc:yielded': (input, event) => {
      leases.yielded(input.key, event.sender, input.pane)
      return null
    },
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
    'series:describe': (input) => host.current.describeSeries(input.seriesId, input.description),
    'series:modules': (input) => host.current.setSeriesModules(input.seriesId, input),
    'publishing:list': (input) => host.current.publishingList(input.seriesId),
    'world:exportPdf': (input, event) =>
      exportWorldPdf(host.current, BrowserWindow.fromWebContents(event.sender), input.worldId),
    'world:rename': (input) => host.current.renameWorld(input.worldId, input.name),
    'arc:delete': (input) =>
      host.current.deleteArc(input.seriesId, input.volumeId, input.arcId, input.chapters),
    'history:list': (input) =>
      host.current.listSnapshots(input.seriesId, input.volumeId, input.chapterId),
    'history:read': (input) =>
      host.current.readSnapshot(input.seriesId, input.volumeId, input.chapterId, input.snapshotId),
    'history:keep': async (input) => {
      await host.current.keepSnapshot(input.seriesId, input.volumeId, input.chapterId, input.reason)
      return null
    },
    'history:restore': (input) =>
      host.current.restoreSnapshot(
        input.seriesId,
        input.volumeId,
        input.chapterId,
        input.snapshotId,
      ),
    'chapter:split': (input) =>
      host.current.splitChapter(
        input.seriesId,
        input.volumeId,
        input.chapterId,
        input.before,
        input.after,
      ),
    'chapter:mergeNext': (input) =>
      host.current.mergeNextChapter(input.seriesId, input.volumeId, input.chapterId),
    'chapter:duplicate': (input) =>
      host.current.duplicateChapter(input.seriesId, input.volumeId, input.chapterId),
    'search:volume': (input) =>
      input.story
        ? host.current.searchStory(input.seriesId, input.query, input)
        : host.current.searchVolume(input.seriesId, input.volumeId, input.query, input),
    'search:replaceAll': (input) =>
      input.story
        ? host.current.replaceAllInStory(input.seriesId, input.query, input.replacement, input)
        : host.current.replaceAllInVolume(
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
    'template:save': (input) =>
      host.current.world.saveTemplate(input.worldId, input.template, input.seen),
    'template:delete': async (input) => {
      await host.current.world.deleteTemplate(input.worldId, input.templateId, input.seen)
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
    'entry:addPicture': (input) =>
      host.current.world.addPicture(input.worldId, input.entryId, input.data),
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
    'inbox:accept': (input) => host.current.world.inboxAccept(input.worldId, input.itemId),
    'inbox:undo': (input) => host.current.world.undoApplied(input.worldId, input.itemId),
    'inbox:answer': async (input) => {
      await host.current.world.answerQuestion(input.worldId, input.itemId, input.answer)
      return null
    },
    'inbox:restore': async (input) => {
      await host.current.world.inboxRestore(input.worldId, input.item)
      return null
    },
    'names:reject': async (input) => {
      await host.current.world.rejectNames(input.worldId, input.names, input.rejected)
      return null
    },
    'map:create': (input) => host.current.world.createMap(input.worldId, input),
    'map:save': (input) =>
      host.current.world.saveMap(input.worldId, input.mapId, input.patch, input.seen),
    'relationship:save': (input) =>
      host.current.world.saveRelationship(input.worldId, input.relationship),
    'relationship:delete': (input) =>
      host.current.world.deleteRelationship(input.worldId, input.relationshipId),
    'relationship:types': (input) =>
      host.current.world.saveRelationshipTypes(input.worldId, input.types, input.seen),
    'board:save': async (input) => {
      await host.current.world.saveBoard(input.worldId, input.positions, input.seen)
      return null
    },
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
    'chapter:setTest': (input) =>
      host.current.setTest(input.seriesId, input.volumeId, input.chapterId, input.testOf),
    'chapter:read': (input) =>
      host.current.readChapter(input.seriesId, input.volumeId, input.chapterId),
    'chapter:save': (input) =>
      host.current.saveChapter(input.seriesId, input.volumeId, input.chapterId, input.patch),
    'volume:update': async (input) => {
      const updated = await host.current.updateVolume(input.seriesId, input.volumeId, {
        name: input.name,
        goals: input.goals,
        ...(input.headings !== undefined ? { settings: { headings: input.headings } } : {}),
      })
      return input.finished === undefined
        ? updated
        : host.current.setVolumeFinished(input.seriesId, input.volumeId, input.finished)
    },
    'library:size': () => host.current.diskUsage(),
    'sync:usage': () => sync.usage(),
    'series:setKind': (input) => host.current.setSeriesKind(input.seriesId, input.kind),
    'world:setFeatures': (input) => host.current.setWorldFeatures(input.worldId, input.features),
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
      // The personal dictionary syncs (nothing else in settings does).
      if (input.dictionary) sync.noteChange()
      return next
    },
    'backup:status': async () => {
      const s = (await settings.read()).backup
      return {
        settings: s,
        backups: s.folder ? await listBackups(s.folder) : [],
        running: backup.busy,
        lastError: backup.lastError,
      }
    },
    'backup:configure': async (input) => {
      const current = (await settings.read()).backup
      const changes = Object.fromEntries(
        Object.entries(input).filter(([, v]) => v !== undefined),
      ) as Partial<typeof current>
      return (await settings.update({ backup: { ...current, ...changes } })).backup
    },
    'backup:chooseFolder': async (_input, event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: 'Folder for backups',
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      }
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      const folder = picked.canceled ? null : (picked.filePaths[0] ?? null)
      if (!folder) return null
      const current = (await settings.read()).backup
      await settings.update({ backup: { ...current, folder } })
      return folder
    },
    'backup:now': () => backup.runNow(),
    'backup:open': async () => {
      const folder = (await settings.read()).backup.folder
      if (folder) await shell.openPath(folder)
      return null
    },
    'window:fullScreen': (input, event) => {
      BrowserWindow.fromWebContents(event.sender)?.setFullScreen(input.on)
      return null
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
  return { libraryChanged: (change) => auto.changed(change) }
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
