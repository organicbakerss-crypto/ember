/**
 * Ollama, the local model runner (http://127.0.0.1:11434 by default). Just
 * what the app needs: the installed models, and a streamed chat.
 */
import { AppError } from '../errors'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class Ollama {
  constructor(
    private readonly host: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.host.replace(/\/+$/, '')}${path}`
  }

  private unreachable(err: unknown): AppError {
    return new AppError(
      'invalid-input',
      `Couldn’t reach Ollama at ${this.host}. Is it running? Start the Ollama app (or run “ollama serve”).`,
      { cause: err },
    )
  }

  /** Installed models, by name. */
  async models(): Promise<string[]> {
    let res: Response
    try {
      res = await this.fetchImpl(this.url('/api/tags'), { signal: AbortSignal.timeout(5000) })
    } catch (err) {
      throw this.unreachable(err)
    }
    if (!res.ok) throw new AppError('invalid-input', `Ollama answered ${res.status}.`)
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name)
  }

  /** A chat answer, streamed to `onToken` as it comes; resolves to the whole text. */
  async chat(input: {
    model: string
    messages: ChatMessage[]
    /** Ask for JSON (Ollama constrains the output). */
    json?: boolean
    temperature?: number
    signal?: AbortSignal
    onToken?: (text: string) => void
  }): Promise<string> {
    let res: Response
    try {
      res = await this.fetchImpl(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: true,
          ...(input.json ? { format: 'json' } : {}),
          options: { temperature: input.temperature ?? 0.7 },
        }),
        signal: input.signal,
      })
    } catch (err) {
      if (input.signal?.aborted) throw new AppError('cancelled', 'Stopped.')
      throw this.unreachable(err)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const message = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error ?? text
        } catch {
          return text
        }
      })()
      if (res.status === 404) {
        throw new AppError(
          'invalid-input',
          `The model “${input.model}” isn’t installed in Ollama. Install it with “ollama pull ${input.model}”, or pick another in Settings → AI.`,
        )
      }
      throw new AppError('invalid-input', `Ollama couldn’t answer: ${message || res.status}`)
    }
    let out = ''
    let pending = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (!line) continue
          const part = JSON.parse(line) as { message?: { content?: string }; error?: string }
          if (part.error) throw new AppError('invalid-input', `Ollama: ${part.error}`)
          const text = part.message?.content ?? ''
          if (text) {
            out += text
            input.onToken?.(text)
          }
        }
      }
    } catch (err) {
      if (input.signal?.aborted) throw new AppError('cancelled', 'Stopped.')
      throw err
    }
    return out
  }
}
