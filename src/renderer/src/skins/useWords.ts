import { useSettings } from '../useTheme'
import type { Presence } from '@shared/world/story'
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

/** The skin's name for a Cast group ("Game over" for "Left the story"), or the plain one. */
export function useCastWords(): (presence: Presence, plain: string) => string {
  const { settings, theme } = useSettings()
  const skin = settings.world.vocabulary ? skinFor(theme) : null
  return (presence, plain) => skin?.cast[presence] ?? plain
}
