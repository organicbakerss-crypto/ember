/**
 * The only bridge between a renderer window and the main process. Exposes a
 * typed `window.api` with request/response calls and change subscriptions.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcEnvelope, RendererApi } from '@shared/ipc'

// Must match IPC_INVOKE_PREFIX / IPC_EVENT_PREFIX in @shared/ipc. Kept as literals because
// importing that module at runtime would bundle zod into the preload.
const INVOKE_PREFIX = 'invoke:'
const EVENT_PREFIX = 'event:'

const api: RendererApi = {
  async invoke(channel, ...args) {
    const envelope = (await ipcRenderer.invoke(
      `${INVOKE_PREFIX}${channel}`,
      args[0],
    )) as IpcEnvelope<never>
    if (envelope.ok) return envelope.value
    // Errors can't cross contextBridge with custom fields, so the code is prefixed to the message.
    throw new Error(`[${envelope.error.code}] ${envelope.error.message}`)
  },
  on(event, listener) {
    const channel = `${EVENT_PREFIX}${event}`
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('api', api)
