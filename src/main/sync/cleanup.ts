/**
 * Cloud clean-up. Every version sync uploads stays in the cloud as a blob;
 * the manifests point at the current ones. Blobs nothing points at, and
 * that are over a month old, are deleted. (A month leaves plenty of room for
 * a computer that's partway through an upload.) History copies are kept.
 *
 * It also repairs: a manifest pointing at a blob that's missing gets it
 * uploaded again, if this computer has a file with exactly that content.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { sha256 } from '../fs/jsonFile'
import type { CloudStore } from './cloud'
import { BLOBS_PREFIX, cloudManifestSchema, UNITS_PREFIX } from './engine'
import { isSyncablePath, isUnitKey } from './units'

export const CLEANUP_AFTER_DAYS = 30

export async function cleanUpCloud(
  cloud: CloudStore,
  root: string,
  now: Date = new Date(),
): Promise<{ deleted: number; freed: number; repaired: number }> {
  // Blobs first: anything uploaded after this listing isn't in it, so can't be deleted.
  const blobs = await cloud.list(BLOBS_PREFIX)
  const used = new Map<string, { unit: string; rel: string }>()
  for (const o of await cloud.list(UNITS_PREFIX)) {
    const unit = o.key.slice(UNITS_PREFIX.length).replace(/\.json$/, '')
    if (!isUnitKey(unit)) continue
    const got = await cloud.get(o.key)
    if (!got) continue
    let files: Record<string, { hash: string | null }>
    try {
      files = cloudManifestSchema.parse(JSON.parse(new TextDecoder().decode(got.body))).files
    } catch {
      // A damaged manifest: delete nothing at all this time.
      return { deleted: 0, freed: 0, repaired: 0 }
    }
    for (const [rel, f] of Object.entries(files)) {
      if (f.hash && isSyncablePath(unit, rel)) used.set(f.hash, { unit, rel })
    }
  }

  const cutoff = now.getTime() - CLEANUP_AFTER_DAYS * 86_400_000
  let deleted = 0
  let freed = 0
  const present = new Set<string>()
  for (const b of blobs) {
    const hash = b.key.slice(BLOBS_PREFIX.length)
    present.add(hash)
    if (used.has(hash) || b.lastModified.getTime() > cutoff) continue
    await cloud.delete(b.key)
    deleted++
    freed += b.size
  }

  let repaired = 0
  for (const [hash, { unit, rel }] of used) {
    if (present.has(hash)) continue
    const bytes = await fs.promises.readFile(join(root, unit, rel)).catch(() => null)
    if (!bytes || sha256(bytes) !== hash) continue
    await cloud.put(`${BLOBS_PREFIX}${hash}`, gzipSync(bytes))
    repaired++
  }
  return { deleted, freed, repaired }
}
