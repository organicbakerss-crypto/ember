/**
 * VoiceStudio, when it's running (on this computer, or another one on the
 * home network): its voices for reading aloud, and its speech-to-text for
 * dictation. Speech is made through its MCP tools (`generate_speech`,
 * `list_voices`) over Streamable HTTP; dictation uses its OpenAI-style
 * `/v1/audio/transcriptions`. It's only talked to, never bundled.
 */

export interface StudioVoice {
  id: string
  name: string
}

export interface StudioOptions {
  /** Where VoiceStudio is, e.g. http://127.0.0.1:3900. */
  base: string
  /** For another computer's VoiceStudio: its key (sent as a bearer token). */
  key?: string
  fetchImpl?: typeof fetch
  /** Give up on a request after this long (speech can be slow). */
  timeoutMs?: number
}

export class VoiceStudio {
  private session: string | null = null
  private nextId = 1

  constructor(private readonly options: StudioOptions) {}

  private get fetch() {
    return this.options.fetchImpl ?? fetch
  }

  private url(path: string) {
    return `${this.options.base.replace(/\/+$/, '')}${path}`
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      ...(this.options.key ? { authorization: `Bearer ${this.options.key}` } : {}),
      ...extra,
    }
  }

  /** Whether VoiceStudio answers at this address. */
  async available(): Promise<boolean> {
    try {
      const res = await this.fetch(this.url('/.well-known/voicestudio-speech'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return false
      const data = (await res.json()) as { service?: string }
      return data.service === 'VoiceStudio'
    } catch {
      return false
    }
  }

  /** One JSON-RPC call to its MCP endpoint (the answer may come as JSON or as an event stream). */
  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const body = {
      jsonrpc: '2.0',
      ...(notify ? {} : { id: this.nextId++ }),
      method,
      ...(params === undefined ? {} : { params }),
    }
    const res = await this.fetch(this.url('/mcp/'), {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.session = sid
    if (res.status === 404 && this.session && method !== 'initialize') {
      // The session expired (VoiceStudio restarted): start a new one and ask again.
      this.session = null
      await this.connect()
      return this.rpc(method, params, notify)
    }
    if (!res.ok) throw new Error(`VoiceStudio answered ${res.status}.`)
    if (notify) return null
    const text = await res.text()
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
      : [text]
    for (const m of messages) {
      let parsed: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        parsed = JSON.parse(m) as typeof parsed
      } catch {
        continue
      }
      if (parsed.error) throw new Error(`VoiceStudio: ${parsed.error.message ?? 'error'}`)
      if (parsed.id === body.id) return parsed.result
    }
    throw new Error('VoiceStudio sent an answer that couldn’t be read.')
  }

  private async connect() {
    if (this.session) return
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'writing-app', version: '1' },
    })
    await this.rpc('notifications/initialized', undefined, true)
  }

  /** Calls a tool; its result (a JSON string in VoiceStudio's tools), parsed. */
  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect()
    const result = (await this.rpc('tools/call', { name, arguments: args })) as {
      isError?: boolean
      structuredContent?: { result?: unknown }
      content?: { type: string; text?: string; data?: string; mimeType?: string }[]
    }
    const text =
      (typeof result.structuredContent?.result === 'string'
        ? result.structuredContent.result
        : null) ?? result.content?.find((c) => c.type === 'text')?.text
    if (result.isError) throw new Error(`VoiceStudio: ${text ?? 'the tool failed'}`)
    // Audio may also come as its own content item.
    const audio = result.content?.find((c) => c.type === 'audio' && c.data)
    if (audio) return { audio_base64: audio.data }
    if (typeof text !== 'string') return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  /** Its saved voices. */
  async voices(): Promise<StudioVoice[]> {
    const data = await this.tool('list_voices', {})
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object'
        ? (Object.values(data).find(Array.isArray) ?? [])
        : []
    return (list as Record<string, unknown>[])
      .filter((v) => v && (typeof v['id'] === 'string' || typeof v['id'] === 'number'))
      .map((v) => ({ id: String(v['id']), name: String(v['name'] ?? v['id']) }))
  }

  /** Speech for some text, as WAV bytes. */
  async speak(input: {
    text: string
    voiceId?: string | null
    speed?: number
    /** Diffusion steps: 8 fast, 16 balanced, 32 best. */
    steps?: number
    /** ISO code (e.g. en); left out, each voice speaks its own. */
    language?: string
  }): Promise<Uint8Array> {
    const data = await this.tool('generate_speech', {
      text: input.text,
      ...(input.language ? { language: input.language } : {}),
      ...(input.voiceId ? { profile_id: input.voiceId } : {}),
      speed: input.speed ?? 1,
      steps: input.steps ?? 16,
      format: 'wav',
    })
    const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
    const b64 = ['wav_base64', 'audio_base64', 'audio', 'data', 'base64'].find(
      (k) => typeof o[k] === 'string' && (o[k] as string).length > 100,
    )
    if (b64) return new Uint8Array(Buffer.from(o[b64] as string, 'base64'))
    const url = typeof o['audio_url'] === 'string' ? o['audio_url'] : null
    if (url) {
      const res = await this.fetch(url.startsWith('http') ? url : this.url(url), {
        headers: this.headers(),
      })
      if (!res.ok) throw new Error(`VoiceStudio’s audio couldn’t be fetched (${res.status}).`)
      return new Uint8Array(await res.arrayBuffer())
    }
    throw new Error('VoiceStudio made speech but sent no audio back.')
  }

  /** What was said in a recording (OpenAI-style transcription). */
  async transcribe(audio: Uint8Array, mime: string, prompt?: string): Promise<string> {
    const form = new FormData()
    const ext = mime.includes('webm') ? 'webm' : mime.includes('wav') ? 'wav' : 'ogg'
    form.append('file', new Blob([audio], { type: mime }), `dictation.${ext}`)
    form.append('model', 'whisper-1')
    if (prompt) form.append('prompt', prompt)
    const res = await this.fetch(this.url('/v1/audio/transcriptions'), {
      method: 'POST',
      headers: this.headers(),
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
    })
    if (!res.ok) throw new Error(`VoiceStudio couldn’t transcribe that (${res.status}).`)
    const data = (await res.json()) as { text?: string }
    return (data.text ?? '').trim()
  }
}
