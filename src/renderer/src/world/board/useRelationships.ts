import { useMemo } from 'react'
import type { IpcInput } from '@shared/ipc'
import type { RelationshipFile } from '@shared/schema'
import { api, describeError } from '../../api'
import { useOverlays } from '../../components/overlays'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'

export type RelationshipDraft = IpcInput<'relationship:save'>['relationship']

/** Saving and deleting relationships, each with Undo. */
export function useRelationships(world: WorldData, record: (step: UndoStep) => void) {
  const { toast } = useOverlays()
  const worldId = world.view.world.id
  return useMemo(() => {
    const name = (id: string) => world.resolve(id)?.name ?? 'someone'
    const restore = (rel: RelationshipFile) =>
      api.invoke('relationship:save', { worldId, relationship: rel })
    return {
      async save(draft: RelationshipDraft): Promise<RelationshipFile | null> {
        const before = draft.id
          ? world.view.relationships.find((r) => r.id === draft.id)
          : undefined
        try {
          const saved = await api.invoke('relationship:save', { worldId, relationship: draft })
          record({
            label: before
              ? `Changed how ${name(saved.from)} and ${name(saved.to)} are linked`
              : `Linked ${name(saved.from)} and ${name(saved.to)}`,
            undo: () =>
              before
                ? restore(before)
                : api.invoke('relationship:delete', { worldId, relationshipId: saved.id }),
          })
          return saved
        } catch (err) {
          toast(describeError(err).message)
          return null
        }
      },
      async remove(rel: RelationshipFile): Promise<void> {
        try {
          const removed = await api.invoke('relationship:delete', {
            worldId,
            relationshipId: rel.id,
          })
          record({
            label: `Removed a link between ${name(rel.from)} and ${name(rel.to)}`,
            undo: () => restore(removed),
          })
        } catch (err) {
          toast(describeError(err).message)
        }
      },
    }
  }, [world, worldId, record, toast])
}
