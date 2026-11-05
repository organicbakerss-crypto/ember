/**
 * When a file changed on both computers, combine the two where that's safe:
 * each side's changes are applied to the version both last agreed on (the
 * base). Lists of things with ids (chapters in the outline, map regions and
 * pins, templates) merge item by item; the board merges portrait by
 * portrait; AI conversations keep the longer one when one just went further,
 * and otherwise become two conversations.
 *
 * Where both sides changed the same value differently, this computer's value
 * is kept and the result is marked not clean: the caller also sets the other
 * version aside, so nothing is lost. Chapters and entries never come here
 * (they're kept side by side as copies), nor do images.
 */
import { newId } from '@shared/ids'
import { unitKind } from './units'

export interface Merged {
  bytes: Uint8Array
  /** False when both sides changed the same thing (this computer's value was kept). */
  clean: boolean
  /** A new file to add beside it (the other side of a conversation that went two ways). */
  copy?: { rel: string; bytes: Uint8Array; name: string }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }

/** Files that can be combined: everything JSON except chapters and entries. */
export function canMerge(unit: string, rel: string): boolean {
  if (!rel.endsWith('.json')) return false
  if (/^(chapters|entries)\//.test(rel)) return false
  return unitKind(unit) !== 'series' || rel === 'series.json' || /^ai\/[^/]+\.json$/.test(rel)
}

/**
 * Both versions combined, or null when they can't be (not JSON, or a kind of
 * file that isn't merged). `base` is null when the agreed version is unknown:
 * then nothing counts as deleted, and differing values keep this computer's.
 */
export function mergeFile(
  unit: string,
  rel: string,
  base: Uint8Array | null,
  mine: Uint8Array,
  theirs: Uint8Array,
  from: { device: string },
): Merged | null {
  if (!canMerge(unit, rel)) return null
  const b = base ? parse(base) : undefined
  const m = parse(mine)
  const t = parse(theirs)
  if (!isObj(m) || !isObj(t)) return null
  if (/^ai\/[^/]+\.json$/.test(rel)) return mergeConversation(b, m, t, from)
  const [value, clean] = merge3(isObj(b) ? b : undefined, m, t)
  const result = rel === 'outline.json' ? dedupeOutline(value as Obj) : value
  return { bytes: encode(result), clean }
}

/* ---------- conversations ---------- */

function mergeConversation(b: Json | undefined, m: Obj, t: Obj, from: { device: string }): Merged {
  const mm = Array.isArray(m['messages']) ? m['messages'] : []
  const tm = Array.isArray(t['messages']) ? t['messages'] : []
  const longer = isPrefix(mm, tm) ? tm : isPrefix(tm, mm) ? mm : null
  if (longer) {
    // One side just went further (and maybe the other renamed it).
    const rest = (o: Obj) => ({ ...o, messages: [] as Json[] })
    const [value, clean] = merge3(isObj(b) ? rest(b) : undefined, rest(m), rest(t))
    return { bytes: encode({ ...(value as Obj), messages: longer }), clean }
  }
  // Continued differently on each computer: two conversations.
  const id = newId('conversation')
  const title = typeof t['title'] === 'string' && t['title'] ? t['title'] : 'Conversation'
  const name = `${title} (from ${from.device || 'another computer'})`.slice(0, 200)
  return {
    bytes: encode(m),
    clean: true,
    copy: { rel: `ai/${id}.json`, bytes: encode({ ...t, id, title: name }), name },
  }
}

function isPrefix(short: Json[], long: Json[]): boolean {
  return short.length <= long.length && short.every((x, i) => same(x, long[i]!))
}

/* ---------- the outline ---------- */

/** A chapter listed twice (moved to different places on each computer) stays in its first place. */
function dedupeOutline(outline: Obj): Obj {
  if (!Array.isArray(outline['items'])) return outline
  const seen = new Set<string>()
  const items: Json[] = []
  for (const item of outline['items']) {
    if (!isObj(item)) continue
    if (item['type'] === 'chapter') {
      const id = String(item['id'])
      if (seen.has(id)) continue
      seen.add(id)
      items.push(item)
    } else if (Array.isArray(item['chapterIds'])) {
      const chapterIds = item['chapterIds'].filter((c) => {
        const key = String(c)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      items.push({ ...item, chapterIds })
    } else items.push(item)
  }
  if (!Array.isArray(outline['tests'])) return { ...outline, items }
  // A test scene made a chapter on one computer stays a chapter; each test once.
  const tests = outline['tests'].filter((t) => {
    if (!isObj(t)) return false
    const id = String(t['id'])
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { ...outline, items, tests }
}

/* ---------- three-way JSON merge ---------- */

/** [merged, clean]. `b` undefined: no base (or the value is new on both sides). */
export function merge3(b: Json | undefined, m: Json, t: Json): [Json, boolean] {
  if (same(m, t)) return [m, true]
  if (b !== undefined) {
    if (same(b, m)) return [t, true]
    if (same(b, t)) return [m, true]
  }
  if (isObj(m) && isObj(t)) return mergeObjects(isObj(b) ? b : undefined, m, t)
  if (Array.isArray(m) && Array.isArray(t)) {
    const ba = Array.isArray(b) ? b : undefined
    if (isIdList(m) && isIdList(t) && (!ba || isIdList(ba))) {
      return mergeLists(ba as Obj[] | undefined, m as Obj[], t as Obj[], (x) => String(x['id']))
    }
    if (isKeyList(m) && isKeyList(t) && (!ba || isKeyList(ba))) {
      return mergeLists(ba, m, t, (x) => String(x))
    }
  }
  return [m, false]
}

function mergeObjects(b: Obj | undefined, m: Obj, t: Obj): [Json, boolean] {
  const out: Obj = {}
  let clean = true
  const keys = [...Object.keys(m), ...Object.keys(t).filter((k) => !(k in m))]
  for (const k of keys) {
    const inB = b !== undefined && k in b
    if (k === 'updatedAt' && typeof m[k] === 'string' && typeof t[k] === 'string') {
      // When it last changed: the later of the two.
      out[k] = m[k] > t[k] ? m[k] : t[k]
    } else if (k in m && k in t) {
      const [v, c] = merge3(inB ? b[k] : undefined, m[k]!, t[k]!)
      out[k] = v
      clean &&= c
    } else if (k in m) {
      // Removed there: gone, unless it changed here meanwhile (then it stays).
      if (!(inB && same(b[k], m[k]!))) out[k] = m[k]!
    } else if (!(inB && same(b[k], t[k]!))) out[k] = t[k]!
  }
  return [out, clean]
}

/**
 * Two versions of a list, item by item. Items added on either side are kept;
 * items removed on one side go unless changed on the other. The order is the
 * side that reordered (this computer's if both did), with the other side's
 * new items placed after the item they followed there.
 */
function mergeLists<T extends Json>(
  b: T[] | undefined,
  m: T[],
  t: T[],
  keyOf: (x: T) => string,
): [Json, boolean] {
  const index = (list: T[]) => new Map(list.map((x) => [keyOf(x), x]))
  const bi = b ? index(b) : undefined
  const mi = index(m)
  const ti = index(t)
  let clean = true
  const kept = new Map<string, Json>()
  for (const [k, x] of mi) {
    const y = ti.get(k)
    const base = bi?.get(k)
    if (y !== undefined) {
      const [v, c] = merge3(base, x, y)
      kept.set(k, v)
      clean &&= c
    } else if (!(base !== undefined && same(base, x))) kept.set(k, x)
  }
  for (const [k, y] of ti) {
    if (mi.has(k)) continue
    const base = bi?.get(k)
    if (!(base !== undefined && same(base, y))) kept.set(k, y)
  }
  const order = (list: T[]) => list.map(keyOf)
  const mineMoved = b ? !sameOrder(order(m), order(b)) : true
  const [lead, other] = mineMoved ? [m, t] : [t, m]
  const result = order(lead).filter((k) => kept.has(k))
  const placed = new Set(result)
  let after: string | null = null
  for (const k of order(other)) {
    if (!kept.has(k)) continue
    if (!placed.has(k)) {
      const at: number = after === null ? 0 : result.indexOf(after) + 1
      result.splice(at, 0, k)
      placed.add(k)
    }
    after = k
  }
  return [result.map((k) => kept.get(k)!), clean]
}

/** Whether the items both lists share are in the same order. */
function sameOrder(a: string[], b: string[]): boolean {
  const inB = new Set(b)
  const inA = new Set(a)
  const x = a.filter((k) => inB.has(k))
  const y = b.filter((k) => inA.has(k))
  return x.every((k, i) => k === y[i])
}

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isIdList = (list: Json[]) =>
  list.every((x) => isObj(x) && typeof x['id'] === 'string') &&
  new Set(list.map((x) => (x as Obj)['id'])).size === list.length

const isKeyList = (list: Json[]) =>
  list.every((x) => typeof x === 'string') && new Set(list).size === list.length

function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as Json[]
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]))
  }
  const ka = Object.keys(a)
  const bo = b as Obj
  return ka.length === Object.keys(bo).length && ka.every((k) => k in bo && same(a[k], bo[k]))
}

function parse(bytes: Uint8Array): Json | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Json
  } catch {
    return undefined
  }
}

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
