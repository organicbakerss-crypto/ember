import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/settings'
import { api, useIpcEvent } from './api'
import { applyTheme, resolveTheme, SYSTEM_THEME, type Theme } from './themes'
import { applySkin, skinFor } from './skins'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

interface SettingsContextValue {
  settings: AppSettings
  /** The theme in use (the chosen one, or the system's light or dark). */
  theme: Theme
  /**
   * Applies a change straight away and saves it. Pass a function to build the
   * change from the latest settings (for several quick changes in a row).
   */
  update: (change: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_APP_SETTINGS,
  theme: resolveTheme(SYSTEM_THEME, false),
  update: () => {},
})

/**
 * Holds the app settings for every view, and applies the parts that are
 * styling: the theme (or the system's light/dark choice), page width and
 * Rhythm colours.
 */
export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [prefersDark, setPrefersDark] = useState(darkQuery.matches)
  // The latest settings, including changes not yet rendered.
  const latest = useRef(settings)
  const setSettings = useCallback((next: AppSettings) => {
    latest.current = next
    setSettingsState(next)
  }, [])

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
    const onChange = () => setPrefersDark(darkQuery.matches)
    darkQuery.addEventListener('change', onChange)
    return () => darkQuery.removeEventListener('change', onChange)
  }, [setSettings])
  useIpcEvent('settings:changed', setSettings)

  const update = useCallback<SettingsContextValue['update']>(
    (change) => {
      const patch = typeof change === 'function' ? change(latest.current) : change
      setSettings({ ...latest.current, ...patch })
      void api.invoke('settings:update', patch)
    },
    [setSettings],
  )

  const { rhythmColors } = settings.analysis
  const theme = resolveTheme(settings.theme, prefersDark)
  const skinLevel = settings.world.skin
  useEffect(() => {
    const root = document.documentElement
    applyTheme(theme, root)
    applySkin(skinFor(theme), skinLevel, root)
    // A chosen Rhythm colour overrides the theme's.
    for (const band of ['short', 'medium', 'long'] as const) {
      const color = rhythmColors[band]
      if (color) root.style.setProperty(`--rhythm-${band}`, color)
    }
  }, [theme, skinLevel, rhythmColors])
  useEffect(() => {
    document.documentElement.style.setProperty('--text-width', `${settings.pageWidth}px`)
  }, [settings.pageWidth])

  return (
    <SettingsContext.Provider value={{ settings, theme, update }}>
      {props.children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext)
}

/** Applies the system light/dark theme straight away, before settings load. */
export function applyInitialTheme(): void {
  applyTheme(resolveTheme(SYSTEM_THEME, darkQuery.matches))
}
