import { useCallback, useEffect, useState } from 'react'
import type { LibraryStatus } from '@shared/ipc'
import { api, useIpcEvent } from './api'
import { flushAll } from './saving'
import { useAppSettings } from './useTheme'
import { Home } from './components/Home'
import { Welcome } from './components/Welcome'

export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const refresh = useCallback(() => void api.invoke('library:status').then(setStatus), [])

  useEffect(refresh, [refresh])
  useAppSettings()
  // The window is closing: save everything first, then let it close.
  useIpcEvent('window:flush', () => {
    void flushAll().finally(() => api.invoke('window:flushed'))
  })
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'library') refresh()
  })

  if (!status) return null
  if (status.state === 'none')
    return <Welcome defaultPath={status.defaultPath} onOpen={setStatus} />
  return <Home key={status.root} />
}
