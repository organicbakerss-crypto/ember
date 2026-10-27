/**
 * The only place the app's name and identity live.
 *
 * Everything else (window titles, data folders, storage paths, the URL scheme)
 * reads from here. Renaming the app means editing this file and the icon.
 */
export const appConfig = {
  /** Display name, shown in window titles and menus. */
  name: 'Ember',
  /** Reverse-DNS app ID (used by the OS and the installer). */
  appId: 'dev.personal.ember',
  /** Device-only folder inside a library (index, outbox, trash, layout). */
  localDataFolder: '.ember-local',
  /** Custom URL scheme for deep links, e.g. `<scheme>://world/<entry-id>`. */
  urlScheme: 'ember',
} as const

export type AppConfig = typeof appConfig
