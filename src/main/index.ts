import { app, BrowserWindow, safeStorage, session, shell } from 'electron'
import { join } from 'node:path'
import { appConfig } from '../../app.config'
import { AppSettingsStore } from './appSettings'
import { guardClose } from './closeGuard'
import { DeviceSettingsStore } from './deviceSettings'
import { DocLeases } from './docLeases'
import { WindowManager, type WindowOptions } from './windows'
import { IPC_EVENT_PREFIX } from '@shared/ipc'
import { captureMenuItems } from './capture'
import { attachScreenshotKey } from './screenshot'
import { broadcast, registerIpc } from './ipc'
import { LibraryHost } from './libraryHost'
import { handleMediaRequests, registerMediaScheme } from './media'
import { setAppMenu } from './menu'
import { applySpelling, attachTextMenu } from './spelling'
import { SyncService } from './sync/service'

// Name and data folder come from the app config, not package.json.
app.setName(appConfig.name)
app.setPath('userData', join(app.getPath('appData'), appConfig.name))

if (!app.requestSingleInstanceLock()) app.quit()
registerMediaScheme()

function createWindow(
  settings: AppSettingsStore,
  host: LibraryHost,
  options: WindowOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: options.bounds?.width ?? 1200,
    height: options.bounds?.height ?? 800,
    ...(options.bounds ? { x: options.bounds.x, y: options.bounds.y } : {}),
    minWidth: 640,
    minHeight: 480,
    title: appConfig.name,
    show: false,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.on('focus', () => sync?.focused())
  guardClose(window)
  attachScreenshotKey(window)
  attachTextMenu(
    window,
    settings,
    (next) => broadcast('settings:changed', next),
    (params) =>
      params.isEditable ? captureMenuItems(window.webContents, params.selectionText, host) : [],
  )

  // Renderer windows never navigate away or open arbitrary windows; links go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl + (options.hash ?? ''))
  else
    void window.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: options.hash?.slice(1),
    })
  window.webContents.on('destroyed', () => leases.releaseAll(window.webContents))
  return window
}

const leases = new DocLeases(
  `${IPC_EVENT_PREFIX}doc:yield`,
  undefined,
  `${IPC_EVENT_PREFIX}doc:returned`,
)
let windows: WindowManager | null = null
let sync: SyncService | null = null

app.on('second-instance', () => windows?.focusMain())

void app.whenReady().then(async () => {
  setAppMenu()
  const settings = new DeviceSettingsStore(app.getPath('userData'))
  const defaultPath = join(app.getPath('documents'), `${appConfig.name} Library`)
  sync = new SyncService({
    userData: app.getPath('userData'),
    leases,
    secrets: {
      canEncrypt: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
    },
    onStatus: (status) => broadcast('sync:status', status),
    onNotice: (message) => broadcast('app:notice', message),
    // End-to-end tests point setup at a stand-in for Cloudflare (never in a packaged app).
    ...(!app.isPackaged && process.env['SYNC_TEST_API'] && process.env['SYNC_TEST_S3']
      ? {
          tokenSetup: {
            api: process.env['SYNC_TEST_API'],
            endpointFor: () => process.env['SYNC_TEST_S3']!,
          },
        }
      : {}),
  })
  const syncService = sync
  const host = new LibraryHost(
    settings,
    defaultPath,
    (change) => {
      broadcast('library:changed', change)
      if (change.kind !== 'trash') syncService.noteChange()
    },
    (library) => void syncService.attach(library),
  )
  await host.restore()
  const appSettings = new AppSettingsStore(app.getPath('userData'))
  applySpelling(session.defaultSession, await appSettings.read())
  const manager = new WindowManager((options) => createWindow(appSettings, host, options), settings)
  windows = manager
  registerIpc(host, appSettings, { manager, leases }, syncService)
  handleMediaRequests(host)
  await manager.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void manager.start()
  })
})

// Before quitting, send what's left (a few seconds at most; the rest goes next time).
let synced = false
app.on('will-quit', (event) => {
  if (synced || !sync) return
  event.preventDefault()
  synced = true
  void sync.flush(8_000).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
