import { createHash } from 'node:crypto'
import {
  CloudError,
  PreconditionFailed,
  type CloudObject,
  type CloudStore,
  type PutCondition,
} from './cloud'

/** What a fault does to one request. */
export type Fault =
  /** The request never arrives (network down). */
  | 'drop'
  /** The request is carried out but the answer is lost. */
  | 'lose-reply'

/**
 * An in-memory bucket for tests and the sync harness. `fault` decides, per
 * request, whether the network fails it.
 */
export class MemoryCloud implements CloudStore {
  readonly objects = new Map<string, { body: Uint8Array; etag: string; lastModified: Date }>()
  fault: (op: string, key: string) => Fault | null = () => null
  requests = 0
  private counter = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  private async run<T>(op: string, key: string, task: () => T): Promise<T> {
    this.requests++
    await Promise.resolve()
    const fault = this.fault(op, key)
    if (fault === 'drop') throw new CloudError('offline', `network down (${op} ${key})`)
    const result = task()
    if (fault === 'lose-reply') throw new CloudError('offline', `connection lost (${op} ${key})`)
    return result
  }

  get(key: string) {
    return this.run('get', key, () => {
      const o = this.objects.get(key)
      return o ? { body: o.body.slice(), etag: o.etag } : null
    })
  }

  put(key: string, body: Uint8Array, condition: PutCondition = {}) {
    return this.run('put', key, () => {
      const existing = this.objects.get(key)
      if (condition.ifNoneMatch === '*' && existing) throw new PreconditionFailed(key)
      if (condition.ifMatch !== undefined && existing?.etag !== condition.ifMatch) {
        throw new PreconditionFailed(key)
      }
      const etag = createHash('md5').update(body).update(String(++this.counter)).digest('hex')
      this.objects.set(key, { body: body.slice(), etag, lastModified: this.now() })
      return { etag }
    })
  }

  list(prefix: string) {
    return this.run('list', prefix, () =>
      [...this.objects]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, o]): CloudObject => ({
          key,
          etag: o.etag,
          size: o.body.byteLength,
          lastModified: o.lastModified,
        })),
    )
  }

  delete(key: string) {
    return this.run('delete', key, () => {
      this.objects.delete(key)
    })
  }
}
