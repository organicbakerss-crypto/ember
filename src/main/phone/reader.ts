/**
 * The phone reader, as this computer looks after it: set up once (one
 * Cloudflare token, one sign-in phrase), then kept up to date by itself.
 * The token and the phrase's hash are kept on this computer only, locked
 * with the system's secure storage where there is one, so later updates need
 * nothing from the writer. The phone keeps its own sign-in.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '../errors'
import { writeJsonFile } from '../fs/jsonFile'
import type { SecretBox } from '../sync/service'
import type { PhoneReaderStatus } from '@shared/phone'
import { deployReader, MIN_PASSPHRASE, passHash, readerScript } from './deploy'

const stateSchema = z.looseObject({
  formatVersion: z.literal(1),
  url: z.string().nullable().catch(null),
  at: z.string().nullable().catch(null),
  /** The Cloudflare token (encrypted when `encrypted`). */
  token: z.string().nullable().catch(null),
  /** The sign-in phrase's hash, which the phone sends (encrypted when `encrypted`). */
  pass: z.string().nullable().catch(null),
  encrypted: z.boolean().catch(false),
  /** Which version of the reader is up there (a hash of its script). */
  version: z.string().nullable().catch(null),
})
type State = z.infer<typeof stateSchema>

export class PhoneReader {
  private updating: Promise<boolean> | null = null

  constructor(
    private readonly where: () => { bucket: string; localDir: string } | null,
    private readonly tools: () => { secrets: SecretBox; fetchImpl?: typeof fetch },
    private readonly api?: string,
  ) {}

  private file(localDir: string) {
    return join(localDir, 'phone.json')
  }

  private async read(localDir: string): Promise<State> {
    const empty: State = {
      formatVersion: 1,
      url: null,
      at: null,
      token: null,
      pass: null,
      encrypted: false,
      version: null,
    }
    let raw: string
    try {
      raw = await fs.promises.readFile(this.file(localDir), 'utf8')
    } catch {
      return empty
    }
    try {
      const r = stateSchema.safeParse(JSON.parse(raw))
      return r.success ? r.data : empty
    } catch {
      return empty
    }
  }

  private open(state: State, value: string | null): string | null {
    if (!value) return null
    try {
      return state.encrypted ? this.tools().secrets.decrypt(value) : value
    } catch {
      return null
    }
  }

  private async write(
    localDir: string,
    next: {
      url: string | null
      at: string | null
      token: string | null
      pass: string | null
      version: string | null
    },
  ) {
    const { secrets } = this.tools()
    const encrypted = secrets.canEncrypt()
    const lock = (v: string | null) => (v && encrypted ? secrets.encrypt(v) : v)
    await writeJsonFile(this.file(localDir), {
      formatVersion: 1,
      url: next.url,
      at: next.at,
      token: lock(next.token),
      pass: lock(next.pass),
      encrypted,
      version: next.version,
    })
  }

  async status(): Promise<PhoneReaderStatus> {
    const w = this.where()
    if (!w)
      return { syncConnected: false, url: null, setUpAt: null, hasToken: false, hasPhrase: false }
    const s = await this.read(w.localDir)
    return {
      syncConnected: true,
      url: s.url,
      setUpAt: s.at,
      hasToken: !!this.open(s, s.token),
      hasPhrase: !!this.open(s, s.pass),
    }
  }

  /** Keeps a Cloudflare token for the phone reader (sync's token can do both). */
  async rememberToken(token: string): Promise<void> {
    const w = this.where()
    if (!w) return
    const s = await this.read(w.localDir)
    await this.write(w.localDir, {
      url: s.url,
      at: s.at,
      token: token.trim(),
      pass: this.open(s, s.pass),
      version: s.version,
    })
  }

  /**
   * Sets it up (or again). A token or phrase left out is the one kept here;
   * the same phrase as before keeps the phone signed in.
   */
  async setup(input: { token?: string; passphrase?: string }): Promise<PhoneReaderStatus> {
    const w = this.where()
    if (!w)
      throw new AppError(
        'invalid-input',
        'Connect sync first (Settings → Sync): the phone reads what syncs.',
      )
    const s = await this.read(w.localDir)
    const token = input.token?.trim() || this.open(s, s.token)
    if (!token)
      throw new AppError(
        'invalid-input',
        'Paste a Cloudflare token first (Open Cloudflare makes one).',
      )
    if (input.passphrase !== undefined && input.passphrase.length < MIN_PASSPHRASE)
      throw new AppError(
        'invalid-input',
        `Pick a sign-in phrase of at least ${MIN_PASSPHRASE} characters.`,
      )
    const pass = input.passphrase ? passHash(input.passphrase) : this.open(s, s.pass)
    if (!pass) throw new AppError('invalid-input', 'Pick a sign-in phrase for your phone.')
    const script = readerScript()
    const { url } = await deployReader({
      token,
      bucket: w.bucket,
      passHash: pass,
      script,
      fetchImpl: this.tools().fetchImpl,
      ...(this.api ? { api: this.api } : {}),
    })
    await this.write(w.localDir, {
      url,
      at: new Date().toISOString(),
      token,
      pass,
      version: versionOf(script),
    })
    return this.status()
  }

  /**
   * Puts a newer version of the reader up, when there is one and everything
   * it needs is kept here. Quiet: a failure waits for next time.
   */
  async update(): Promise<boolean> {
    if (this.updating) return this.updating
    this.updating = (async () => {
      try {
        const w = this.where()
        if (!w) return false
        const s = await this.read(w.localDir)
        if (!s.url || !this.open(s, s.token) || !this.open(s, s.pass)) return false
        if (s.version === versionOf(readerScript())) return false
        await this.setup({})
        return true
      } catch {
        return false
      } finally {
        this.updating = null
      }
    })()
    return this.updating
  }
}

const versionOf = (script: string) => createHash('sha256').update(script).digest('hex').slice(0, 16)
