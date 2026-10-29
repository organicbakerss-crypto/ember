import { useMemo } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { FactValue, RelationshipFile, WorldEntryFile } from '@shared/schema'
import { api, describeError } from '../api'
import { flushAll } from '../saving'
import { useOverlays } from '../components/overlays'
import type { UndoStep } from './useUndo'
import type { WorldData } from './useWorld'

/** Puts entries back exactly as they were (everything an action may have changed). */
async function restoreEntries(worldId: string, entries: WorldEntryFile[]): Promise<void> {
  for (const e of entries) {
    await api.invoke('entry:save', {
      worldId,
      entryId: e.id,
      patch: {
        name: e.name,
        aliases: e.aliases,
        template: e.template,
        facts: e.facts,
        body: e.body,
        quotes: e.quotes,
        portrait: e.portrait,
        mergedFrom: e.mergedFrom,
      },
    })
  }
}

/** Puts relationships back exactly as they were (saving with the same ids). */
async function restoreRelationships(
  worldId: string,
  relationships: RelationshipFile[],
): Promise<void> {
  for (const r of relationships) {
    await api.invoke('relationship:save', { worldId, relationship: r })
  }
}

/** World actions with undo and safe confirmation, shared by every World view. */
export function useWorldActions(world: WorldData | null, record: (step: UndoStep) => void) {
  const { choose, toast } = useOverlays()
  const worldId = world?.view.world.id

  return useMemo(() => {
    const fail = (err: unknown) => {
      toast(describeError(err).message)
      return null
    }
    const linkedFrom = (entryId: string): EntrySummary[] =>
      world?.view.entries.filter(
        (e) =>
          e.id !== entryId &&
          Object.values(e.facts).some((vs) =>
            vs.some(
              (v) => v.link === entryId || (v.from?.kind === 'event' && v.from.entryId === entryId),
            ),
          ),
      ) ?? []

    return {
      async create(
        name: string,
        template: string,
        facts?: Record<string, FactValue[]>,
      ): Promise<WorldEntryFile | null> {
        if (!worldId) return null
        try {
          const entry = await api.invoke('entry:create', { worldId, name, template, facts })
          record({
            label: `Added ${entry.name}`,
            undo: () =>
              api.invoke('trash:add', { target: { kind: 'entry', worldId, entryId: entry.id } }),
          })
          return entry
        } catch (err) {
          return fail(err)
        }
      },

      /** Deleting asks what to do with entries that link to this one. Everything goes to the trash. */
      async remove(entry: EntrySummary): Promise<boolean> {
        if (!worldId) return false
        const linked = linkedFrom(entry.id)
        let unlink = false
        if (linked.length) {
          const names = linked
            .slice(0, 4)
            .map((e) => e.name)
            .join(', ')
          const answer = await choose(
            `Delete “${entry.name}”?`,
            [
              { value: 'unlink', label: 'Delete and remove the links', danger: true },
              { value: 'keep', label: 'Delete, keep the links', primary: true },
            ],
            `${linked.length === 1 ? 'One entry links' : `${linked.length} entries link`} to it (${names}${linked.length > 4 ? ', …' : ''}). Kept links show as missing until it is restored. It goes to the trash either way.`,
          )
          if (!answer) return false
          unlink = answer === 'unlink'
        }
        try {
          await flushAll()
          const result = await api.invoke('entry:delete', { worldId, entryId: entry.id, unlink })
          record({
            label: `Deleted ${entry.name}`,
            undo: async () => {
              await api.invoke('trash:restore', { trashId: result.trash.id })
              await restoreEntries(worldId, result.before)
              await restoreRelationships(worldId, result.relationships)
            },
          })
          return true
        } catch (err) {
          fail(err)
          return false
        }
      },

      /** Merges `merge` into `keep` (the one kept). */
      async merge(keep: EntrySummary, merge: EntrySummary): Promise<boolean> {
        if (!worldId) return false
        const answer = await choose(
          `Merge “${merge.name}” into “${keep.name}”?`,
          [{ value: 'merge', label: 'Merge', primary: true }],
          `“${merge.name}” becomes another name for “${keep.name}”. Its details, quotes and page are added, links to it move over, and it goes to the trash.`,
        )
        if (!answer) return false
        try {
          await flushAll()
          const result = await api.invoke('entry:merge', {
            worldId,
            keepId: keep.id,
            mergeId: merge.id,
          })
          record({
            label: `Merged ${merge.name} into ${keep.name}`,
            undo: async () => {
              await api.invoke('trash:restore', { trashId: result.trash.id })
              await restoreEntries(worldId, result.before)
              await restoreRelationships(worldId, result.relationships)
            },
          })
          return true
        } catch (err) {
          fail(err)
          return false
        }
      },

      async duplicate(entry: EntrySummary): Promise<WorldEntryFile | null> {
        if (!worldId) return null
        try {
          await flushAll()
          const copy = await api.invoke('entry:duplicate', { worldId, entryId: entry.id })
          record({
            label: `Duplicated ${entry.name}`,
            undo: () =>
              api.invoke('trash:add', { target: { kind: 'entry', worldId, entryId: copy.id } }),
          })
          return copy
        } catch (err) {
          return fail(err)
        }
      },

      async pin(entry: EntrySummary, pinned: boolean): Promise<void> {
        if (!worldId) return
        try {
          await api.invoke('world:pin', { worldId, entryId: entry.id, pinned })
        } catch (err) {
          fail(err)
        }
      },
    }
  }, [world, worldId, record, choose, toast])
}

export type WorldActions = ReturnType<typeof useWorldActions>
