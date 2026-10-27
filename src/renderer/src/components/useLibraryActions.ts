import type { TrashTarget } from '@shared/ipc'
import type { CoverTarget } from '@shared/media'
import { api, describeError } from '../api'
import { flushAll } from '../saving'
import { useOverlays } from './overlays'

/** Actions shared by menus across the app: delete (to the trash, with Undo) and change cover. */
export function useLibraryActions() {
  const { toast } = useOverlays()

  const moveToTrash = async (target: TrashTarget, name: string) => {
    try {
      // Anything still being typed is saved before its file moves.
      await flushAll()
      const entry = await api.invoke('trash:add', { target })
      toast(`“${name || 'Untitled'}” moved to the trash.`, {
        label: 'Undo',
        run: () =>
          api
            .invoke('trash:restore', { trashId: entry.id })
            .catch((err) => toast(describeError(err).message)),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const pickCover = (target: CoverTarget) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        await api.invoke('cover:set', { target, data: new Uint8Array(await file.arrayBuffer()) })
      } catch (err) {
        toast(describeError(err).message)
      }
    }
    input.click()
  }

  return { moveToTrash, pickCover, toast }
}
