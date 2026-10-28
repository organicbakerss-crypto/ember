import type { IpcInput } from '@shared/ipc'
import type { RichTextDoc } from '@shared/schema'
import { api } from '../api'
import { useAutosave } from './useAutosave'

export type { SaveState } from './useAutosave'

type ChapterPatch = IpcInput<'chapter:save'>['patch']

/** Autosave for one chapter (see useAutosave). */
export function useChapterSaver(
  ref: { seriesId: string; volumeId: string; chapterId: string },
  getContent: () => RichTextDoc | null,
) {
  return useAutosave<ChapterPatch>(
    (patch) => api.invoke('chapter:save', { ...ref, patch }),
    () => {
      const content = getContent()
      return content ? { content } : null
    },
  )
}
