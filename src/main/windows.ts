/**
 * The app's windows: one main window, and any panes torn off into windows
 * of their own. A torn-off window opens at its pane's route and can be
 * docked back beside the main window's view. Where the windows were, and
 * which panes were torn off, is remembered on this device (never synced)
 * and restored on the next start.
 */
import type { BrowserWindow } from 'electron'
import { IPC_EVENT_PREFIX, type IpcEvents } from '@shared/ipc'
import { paneHash, type PaneRoute } from '@shared/panes'
import type { DeviceSettingsStore, WindowBounds } from './deviceSettings'

export interface WindowOptions {
  /** Address fragment: a torn-off pane's route. */
  hash?: string
  bounds?: WindowBounds | null
}

const SAVE_DELAY_MS = 600
/** A new torn-off window opens this far from the window it came from. */
const CASCADE = 40

export class WindowManager {
  private main: BrowserWindow | null = null
  private mainBounds: WindowBounds | null = null
  private readonly panes = new Map<BrowserWindow, PaneRoute>()
  /** The main window is closing and taking its torn-off windows with it (they stay remembered). */
  private closingAll = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly make: (options: WindowOptions) => BrowserWindow,
    private readonly device: DeviceSettingsStore,
  ) {}

  /** Opens the main window and any torn-off windows from last time. */
  async start(): Promise<void> {
    const saved = (await this.device.read()).windows
    this.openMain(saved.main)
    for (const pane of saved.panes) this.openPane(pane.route, pane.bounds)
  }

  focusMain(): void {
    const w = this.main
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.focus()
  }

  private openMain(bounds: WindowBounds | null): void {
    this.closingAll = false
    const w = this.make({ bounds })
    this.main = w
    this.mainBounds = bounds
    this.track(w)
    w.on('close', () => {
      if (this.closingAll) return
      // Remember the torn-off windows, then close them with the main window.
      this.closingAll = true
      this.saveNow()
      for (const pane of this.panes.keys()) if (!pane.isDestroyed()) pane.close()
    })
    w.on('closed', () => {
      if (this.main === w) this.main = null
    })
  }

  /** Pops a pane out into its own window (near `from`, unless bounds are given). */
  openPane(route: PaneRoute, bounds?: WindowBounds | null, from?: BrowserWindow | null): void {
    const near = from && !from.isDestroyed() ? from.getBounds() : null
    const w = this.make({
      hash: paneHash(route),
      bounds:
        bounds ??
        (near && {
          x: near.x + CASCADE,
          y: near.y + CASCADE,
          width: Math.max(640, Math.round(near.width * 0.6)),
          height: near.height,
        }),
    })
    this.panes.set(w, route)
    this.track(w)
    w.on('closed', () => {
      this.panes.delete(w)
      if (!this.closingAll) this.save()
    })
    this.save()
  }

  /**
   * Puts a torn-off pane back beside the main window's view, and closes its
   * window (with `keep`, only shows the route in the main window).
   */
  dock(from: BrowserWindow | null, route: PaneRoute, keep = false): void {
    const main = this.main
    if (!main || main.isDestroyed()) return
    this.send(main, 'pane:dock', route)
    this.focusMain()
    if (!keep && from && from !== main && !from.isDestroyed()) from.close()
  }

  /** A torn-off window's pane moved; it reopens there next time. */
  setRoute(from: BrowserWindow | null, route: PaneRoute): void {
    if (!from || !this.panes.has(from)) return
    this.panes.set(from, route)
    this.save()
  }

  /** Shows an entry in a torn-off window of its world, if one is open. */
  showEntry(worldId: string, entryId: string): boolean {
    for (const [w, route] of this.panes) {
      if (w.isDestroyed() || route.kind !== 'world' || route.worldId !== worldId) continue
      this.send(w, 'pane:showEntry', { worldId, entryId })
      if (w.isMinimized()) w.restore()
      w.focus()
      return true
    }
    return false
  }

  private send<E extends keyof IpcEvents>(w: BrowserWindow, event: E, payload: IpcEvents[E]) {
    w.webContents.send(`${IPC_EVENT_PREFIX}${event}`, payload)
  }

  /** Saves window positions a moment after they stop moving. */
  private track(w: BrowserWindow): void {
    const moved = () => {
      if (w === this.main && !w.isDestroyed()) this.mainBounds = w.getNormalBounds()
      this.save()
    }
    w.on('resize', moved)
    w.on('move', moved)
  }

  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS)
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer)
    if (this.main && !this.main.isDestroyed()) this.mainBounds = this.main.getNormalBounds()
    const panes = [...this.panes]
      .filter(([w]) => !w.isDestroyed())
      .map(([w, route]) => ({ route, bounds: w.getNormalBounds() }))
    void this.device
      .update({ windows: { main: this.mainBounds, panes } })
      .catch((err) => console.error('Could not save window layout:', err))
  }
}
