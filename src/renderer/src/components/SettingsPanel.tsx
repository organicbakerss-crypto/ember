import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc'
import { api, useIpcEvent } from '../api'
import { SYSTEM_THEME, themes } from '../themes'

/** App settings. For now: the theme. */
export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => void api.invoke('settings:get').then(setSettings), [])
  useIpcEvent('settings:changed', setSettings)
  if (!settings) return null

  const choose = (theme: string) => {
    setSettings({ ...settings, theme })
    void api.invoke('settings:update', { theme })
  }
  const options = [{ id: SYSTEM_THEME, name: 'Match system (light or dark)' }, ...themes]

  return (
    <div className="settings-panel">
      <h2>Settings</h2>
      <fieldset>
        <legend>Theme</legend>
        {options.map((theme) => (
          <label key={theme.id} className="radio">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === theme.id}
              onChange={() => choose(theme.id)}
            />
            {theme.name}
          </label>
        ))}
      </fieldset>
    </div>
  )
}
