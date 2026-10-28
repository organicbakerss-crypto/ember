import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { appConfig } from '../../app.config'
import { AppSettingsStore } from './appSettings'
import { guardClose } from './closeGuard'
import { DeviceSettingsStore } from './deviceSettings'
import { captureMenuItems } from './capture'
import { broadcast, registerIpc } from './ipc'
import { LibraryHost } from './libraryHost'
import { handleMediaRequests, registerMediaScheme } from './media'
import { setAppMenu } from './menu'
import { applySpelling, attachTextMenu } from './spelling'

// Name and data folder come from the app config, not package.json.
app.setName(appConfig.name)
app.setPath('userData', join(app.getPath('appData'), appConfig.name))

if (!app.requestSingleInstanceLock()) app.quit()
registerMediaScheme()

function createWindow(settings: AppSettingsStore, host: LibraryHost): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
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
  guardClose(window)
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
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

void app.whenReady().then(async () => {
  setAppMenu()
  const settings = new DeviceSettingsStore(app.getPath('userData'))
  const defaultPath = join(app.getPath('documents'), `${appConfig.name} Library`)
  const host = new LibraryHost(settings, defaultPath, (change) =>
    broadcast('library:changed', change),
  )
  await host.restore()
  const appSettings = new AppSettingsStore(app.getPath('userData'))
  applySpelling(session.defaultSession, await appSettings.read())
  registerIpc(host, appSettings)
  handleMediaRequests(host)
  createWindow(appSettings, host)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(appSettings, host)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
