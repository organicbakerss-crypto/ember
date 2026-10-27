/**
 * Never lose words on close: before a window closes, it is asked to save
 * everything still pending, and closes once it says it is done (or after a
 * timeout, so a stuck window can still be closed).
 */
import type { BrowserWindow, WebContents } from 'electron'
import { IPC_EVENT_PREFIX } from '@shared/ipc'

const FLUSH_TIMEOUT_MS = 4000
const flushed = new WeakSet<WebContents>()

export function guardClose(window: BrowserWindow): void {
  window.on('close', (event) => {
    const contents = window.webContents
    if (flushed.has(contents) || contents.isDestroyed() || contents.isCrashed()) return
    event.preventDefault()
    contents.send(`${IPC_EVENT_PREFIX}window:flush`, null)
    setTimeout(() => allowClose(window), FLUSH_TIMEOUT_MS)
  })
}

/** Called when a window reports that everything is saved. */
export function confirmFlushed(window: BrowserWindow | null): void {
  if (window) allowClose(window)
}

function allowClose(window: BrowserWindow): void {
  if (window.isDestroyed() || flushed.has(window.webContents)) return
  flushed.add(window.webContents)
  window.close()
}
