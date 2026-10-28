/** View helpers for world entries: templates, quick facts, links between entries. */
import type { EntrySummary } from '@shared/ipc'
import type { FactValue, Template, TemplateField } from '@shared/schema'
import { valuesAt, type Moment } from '@shared/world/facts'
import { effectiveTemplate, FALLBACK_TEMPLATE, type Lens } from '@shared/world/templates'
import { loadLocal, saveLocal } from '../storage'
import type { WorldData } from './useWorld'

export function templateOf(world: WorldData, entry: Pick<EntrySummary, 'template' | 'facts'>) {
  return effectiveTemplate(world.view.templates, entry.template, entry.facts)
}

export function lensOf(world: WorldData, entry: Pick<EntrySummary, 'template'>): Lens {
  return (world.templates.get(entry.template) ?? FALLBACK_TEMPLATE).lens
}

export function templateName(world: WorldData, templateId: string): string {
  return world.templates.get(templateId)?.name ?? 'Note'
}

/** A value as words: text, or the linked entry's name. */
export function valueLabel(world: WorldData, value: FactValue): string {
  if (value.link) return world.resolve(value.link)?.name ?? '(missing entry)'
  return value.text ?? ''
}

export interface ShownFact {
  field: TemplateField
  values: FactValue[]
}

/** Fields with values at a moment, in template order; `quick` limits to the quick facts strip. */
export function shownFacts(
  world: WorldData,
  entry: Pick<EntrySummary, 'template' | 'facts'>,
  at: Moment,
  quick?: boolean,
): ShownFact[] {
  const template = templateOf(world, entry)
  return template.fields
    .filter((f) => quick === undefined || f.quick === quick)
    .map((field) => ({
      field,
      values: valuesAt(field, entry.facts[field.id], at, world.positions),
    }))
    .filter((f) => f.values.length > 0)
}

export const MAX_QUICK_FACTS = 5

/** Entries linking to this one, grouped by how they link ("Members", "Here now"). */
export function backlinks(
  world: WorldData,
  entryId: string,
  at: Moment,
): { label: string; entries: EntrySummary[] }[] {
  const ids = new Set([entryId, ...(world.byId.get(entryId)?.mergedFrom ?? [])])
  const groups = new Map<string, EntrySummary[]>()
  const add = (label: string, e: EntrySummary) => {
    const list = groups.get(label) ?? []
    if (!list.includes(e)) list.push(e)
    groups.set(label, list)
  }
  for (const other of world.view.entries) {
    if (other.id === entryId) continue
    for (const field of templateOf(world, other).fields) {
      const values = valuesAt(field, other.facts[field.id], at, world.positions)
      if (values.some((v) => v.link && ids.has(v.link))) add(field.reverse ?? field.label, other)
    }
    if (other.links.some((l) => ids.has(l))) add('Mentioned on', other)
  }
  return [...groups].map(([label, entries]) => ({ label, entries }))
}

export function templatesInLens(templates: readonly Template[], lens: Lens): Template[] {
  return templates.filter((t) => t.lens === lens)
}

/* ---------- recent entries (per device) ---------- */

const MAX_RECENT = 8

export function loadRecent(worldId: string): string[] {
  try {
    const raw = JSON.parse(loadLocal(`world.recent.${worldId}`) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function pushRecent(worldId: string, entryId: string): string[] {
  const next = [entryId, ...loadRecent(worldId).filter((id) => id !== entryId)].slice(0, MAX_RECENT)
  saveLocal(`world.recent.${worldId}`, JSON.stringify(next))
  return next
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : name.slice(0, 2)).toUpperCase()
}
