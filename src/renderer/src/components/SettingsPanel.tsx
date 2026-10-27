import { useEffect, useState } from 'react'
import { PAGE_WIDTH, type AppSettings } from '@shared/ipc'
import { api, useIpcEvent } from '../api'
import { SYSTEM_THEME, themes } from '../themes'

/** App settings. For now: the theme. */
export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => void api.invoke('settings:get').then(setSettings), [])
  useIpcEvent('settings:changed', setSettings)
  if (!settings) return null

  const change = (patch: Partial<AppSettings>) => {
    setSettings({ ...settings, ...patch })
    void api.invoke('settings:update', patch)
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
              onChange={() => change({ theme: theme.id })}
            />
            {theme.name}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Page width</legend>
        <input
          type="range"
          aria-label="Page width"
          min={PAGE_WIDTH.min}
          max={PAGE_WIDTH.max}
          step={20}
          value={settings.pageWidth}
          onChange={(e) => change({ pageWidth: Number(e.target.value) })}
        />
        <span className="muted small">
          {settings.pageWidth}px text column
          {settings.pageWidth === PAGE_WIDTH.default ? ' (default)' : ''}
          {settings.pageWidth !== PAGE_WIDTH.default && (
            <>
              {' · '}
              <button
                className="link small"
                onClick={() => change({ pageWidth: PAGE_WIDTH.default })}
              >
                Reset
              </button>
            </>
          )}
        </span>
      </fieldset>
    </div>
  )
}
