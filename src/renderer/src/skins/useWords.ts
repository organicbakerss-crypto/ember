import { useSettings } from '../useTheme'
import { skinFor, type SkinWord } from '.'

/**
 * The skin's word for a thing (Atlas for Where, in Fantasy), or the plain
 * word: without a skin, or with themed words turned off in Settings.
 */
export function useWords(): (key: SkinWord, plain: string) => string {
  const { settings, theme } = useSettings()
  const skin = settings.world.vocabulary ? skinFor(theme) : null
  return (key, plain) => skin?.words[key] ?? plain
}
