import { useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/ipc'
import { api, useIpcEvent } from './api'

/** Sync's status, kept live (null until known). */
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    let live = true
    api.invoke('sync:status').then(
      (s) => live && setStatus(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  useIpcEvent('sync:status', setStatus)
  return status
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Sync in a few words, for the status bar. Null when sync is off. */
export function syncLabel(s: SyncStatus | null): { text: string; problem: boolean } | null {
  if (!s?.connected) return null
  switch (s.state) {
    case 'syncing':
      return { text: 'Syncing…', problem: false }
    case 'offline':
      return {
        text: s.pending
          ? `Offline, ${plural(s.pending, 'change')} saved locally`
          : 'Offline, all saved locally',
        problem: false,
      }
    case 'error':
      return { text: 'Sync problem', problem: true }
    default:
      return {
        text: s.pending ? `${plural(s.pending, 'change')} to sync` : 'Synced',
        problem: false,
      }
  }
}
