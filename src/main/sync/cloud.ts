/**
 * The cloud, as sync sees it: a bucket of objects with ETags and
 * conditional writes. The app talks to Cloudflare R2 (or any S3-compatible
 * store) directly; tests use an in-memory one with faults.
 */

export interface CloudObject {
  key: string
  /** Without quotes. */
  etag: string
  size: number
  lastModified: Date
}

export interface PutCondition {
  /** Only if the object still has this ETag (it hasn't changed since it was read). */
  ifMatch?: string
  /** Only if no object exists yet. */
  ifNoneMatch?: '*'
}

export interface CloudStore {
  /** null when there's no such object. */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>
  /** Throws PreconditionFailed when the condition doesn't hold. */
  put(key: string, body: Uint8Array, condition?: PutCondition): Promise<{ etag: string }>
  /** Every object under a prefix (all pages). */
  list(prefix: string): Promise<CloudObject[]>
  delete(key: string): Promise<void>
}

/** A conditional write was refused: someone else wrote first (or the object already exists). */
export class PreconditionFailed extends Error {
  constructor(key: string) {
    super(`Changed in the cloud meanwhile: ${key}`)
    this.name = 'PreconditionFailed'
  }
}

export type CloudErrorKind = 'offline' | 'auth' | 'other'

/** The cloud couldn't be reached or refused the request. */
export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CloudError'
  }
}

export const stripQuotes = (etag: string) => etag.replace(/^W\//, '').replace(/^"|"$/g, '')
