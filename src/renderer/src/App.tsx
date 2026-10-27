import { useCallback, useEffect, useState } from 'react'
import type { LibraryStatus } from '@shared/ipc'
import { api, useIpcEvent } from './api'
import { Home } from './components/Home'
import { Welcome } from './components/Welcome'

export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const refresh = useCallback(() => void api.invoke('library:status').then(setStatus), [])

  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'library') refresh()
  })

  if (!status) return null
  if (status.state === 'none')
    return <Welcome defaultPath={status.defaultPath} onOpen={setStatus} />
  return <Home key={status.root} />
}
