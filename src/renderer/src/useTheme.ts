import { useEffect, useState } from 'react'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/settings'
import { api, useIpcEvent } from './api'
import { applyTheme, resolveTheme, SYSTEM_THEME } from './themes'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

/** Applies the user's theme (or the system's light/dark choice) and keeps it up to date. */
export function useAppSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [prefersDark, setPrefersDark] = useState(darkQuery.matches)

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
    const onChange = () => setPrefersDark(darkQuery.matches)
    darkQuery.addEventListener('change', onChange)
    return () => darkQuery.removeEventListener('change', onChange)
  }, [])
  useIpcEvent('settings:changed', setSettings)

  useEffect(
    () => applyTheme(resolveTheme(settings.theme, prefersDark)),
    [settings.theme, prefersDark],
  )
  useEffect(() => {
    document.documentElement.style.setProperty('--text-width', `${settings.pageWidth}px`)
  }, [settings.pageWidth])
  return settings
}

/** Applies the system light/dark theme straight away, before settings load. */
export function applyInitialTheme(): void {
  applyTheme(resolveTheme(SYSTEM_THEME, darkQuery.matches))
}
