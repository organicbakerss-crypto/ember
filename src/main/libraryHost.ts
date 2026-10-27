/** Holds the currently open library and remembers its location for next launch. */
import type { LibraryChange, LibraryStatus } from '@shared/ipc'
import { AppError } from './errors'
import type { DeviceSettingsStore } from './deviceSettings'
import { Library } from './library/library'

export class LibraryHost {
  private library: Library | null = null

  constructor(
    private readonly settings: DeviceSettingsStore,
    readonly defaultPath: string,
    private readonly onChange: (change: LibraryChange) => void,
  ) {}

  /** Reopens the library used last time, if it is still there. */
  async restore(): Promise<void> {
    const { libraryPath } = await this.settings.read()
    if (!libraryPath) return
    try {
      this.library = await Library.open(libraryPath, { onChange: this.onChange })
    } catch (err) {
      // Moved or unplugged drive: show the welcome screen, keep the setting for next time.
      console.warn(`Could not reopen library at ${libraryPath}:`, err)
    }
  }

  async open(path: string): Promise<LibraryStatus> {
    this.library = await Library.open(path, { create: true, onChange: this.onChange })
    await this.settings.update({ libraryPath: path })
    this.onChange({ kind: 'library' })
    return this.status()
  }

  status(): LibraryStatus {
    return this.library
      ? { state: 'open', root: this.library.root }
      : { state: 'none', defaultPath: this.defaultPath }
  }

  get current(): Library {
    if (!this.library) throw new AppError('no-library', 'No library is open.')
    return this.library
  }
}
