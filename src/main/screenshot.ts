/**
 * F2 copies a screenshot of the window to the clipboard (nothing is saved to
 * disk). Handled in main so it works wherever the focus is.
 */
import { clipboard, ClipboardItem, type BrowserWindow } from 'electron'
import { IPC_EVENT_PREFIX } from '@shared/ipc'

export function attachScreenshotKey(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F2' || input.isAutoRepeat) return
    if (input.control || input.alt || input.meta || input.shift) return
    event.preventDefault()
    const notify = (message: string) =>
      window.webContents.send(`${IPC_EVENT_PREFIX}app:notice`, message)
    void window.webContents
      .capturePage()
      .then((image) =>
        clipboard.write([
          new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) }),
        ]),
      )
      .then(
        () => notify('Screenshot copied to the clipboard.'),
        () => notify('Couldn’t take a screenshot.'),
      )
  })
}
