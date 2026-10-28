import { useCallback, useEffect, useState } from 'react'
import type { LibraryStatus } from '@shared/ipc'
import { api, useIpcEvent } from './api'
import { flushAll } from './saving'
import { SettingsProvider, useSettings } from './useTheme'
import { Home } from './components/Home'
import { CommandProvider, useCommands } from './components/commands'
import { OverlayProvider, useOverlays } from './components/overlays'
import { SYSTEM_THEME, themes } from './themes'
import { Welcome } from './components/Welcome'

export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const refresh = useCallback(() => void api.invoke('library:status').then(setStatus), [])

  useEffect(refresh, [refresh])
  // The window is closing: save everything first, then let it close.
  useIpcEvent('window:flush', () => {
    void flushAll().finally(() => api.invoke('window:flushed'))
  })
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'library') refresh()
  })

  if (!status) return null
  return (
    <SettingsProvider>
      <OverlayProvider>
        <CommandProvider>
          <ThemeCommands />
          <MainNotices />
          <LighterMode />
          {status.state === 'none' ? (
            <Welcome defaultPath={status.defaultPath} onOpen={setStatus} />
          ) : (
            <Home key={status.root} />
          )}
        </CommandProvider>
      </OverlayProvider>
    </SettingsProvider>
  )
}

function ThemeCommands() {
  const options = [{ id: SYSTEM_THEME, name: 'Match system' }, ...themes]
  useCommands(
    'themes',
    options.map((t) => ({
      id: `theme:${t.id}`,
      group: 'Theme',
      title: t.name,
      run: () => void api.invoke('settings:update', { theme: t.id }),
    })),
  )
  return null
}

/** Notices sent by the main process (like "Screenshot copied"). */
function MainNotices() {
  const { toast } = useOverlays()
  useIpcEvent('app:notice', (message) => toast(message))
  return null
}

/** Lighter mode: no animations or transitions anywhere (also follows reduced motion in CSS). */
function LighterMode() {
  const { settings } = useSettings()
  const lighter = settings.world.lighter
  useEffect(() => {
    if (lighter) document.documentElement.dataset['lighter'] = ''
    else delete document.documentElement.dataset['lighter']
  }, [lighter])
  return null
}
