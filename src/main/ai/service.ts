/**
 * The AI layer: one place in the main process that talks to the model, so
 * features don't care which model answers (Ollama, or ChatGPT through Codex). It builds what
 * the model reads (the reading scope, the world entries named in it), streams
 * answers back to the window that asked, and can stop any request.
 *
 * Nothing here writes to the library: answers and suggested fixes go back to
 * the window, and only the writer's own accept changes anything.
 */
import { docParagraphs } from '@shared/analysis/doc'
import { entryTerms, nameMatcher } from '@shared/names'
import type { AiSettings } from '@shared/settings'
import type { AiStatus } from '@shared/ipc'
import { AppError } from '../errors'
import type { LibraryHost } from '../libraryHost'
import { Ollama, type ChatMessage } from './ollama'
import { CODEX_MISSING, CodexClient, findCodex } from './codex'
import {
  chatMessages,
  grammarMessages,
  parseGrammar,
  summaryMessages,
  type AiMode,
  type PromptContext,
  type ScopeKind,
} from './prompts'

/** Most entries put in front of the model at once, and how much of each. */
const MAX_ENTRIES = 6
const MAX_ENTRY_CHARS = 1500
const MAX_DIGEST_CHARS = 8000
/** A whole chapter longer than this is read in parts and summarised. */
const CHAPTER_WORDS = 2500
/** Grammar is checked a few paragraphs at a time. */
const GRAMMAR_BATCH_CHARS = 1500

export interface AskInput {
  requestId: string
  mode: AiMode
  messages: { role: 'user' | 'assistant'; content: string }[]
  scope: {
    kind: ScopeKind
    seriesId: string
    volumeId: string
    chapterId: string
    /** The selection or what's on screen (for the whole chapter, read here). */
    text: string
  } | null
}

/** Whoever answers: Ollama or ChatGPT (through Codex). */
interface Provider {
  chat(input: {
    messages: ChatMessage[]
    json?: boolean
    temperature?: number
    signal?: AbortSignal
    onToken?: (text: string) => void
  }): Promise<string>
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

export class AiService {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly options: {
      settings: () => Promise<AiSettings>
      host: LibraryHost
      fetchImpl?: typeof fetch
    },
  ) {}

  private async client(): Promise<Provider> {
    const settings = await this.options.settings()
    if (!settings.enabled)
      throw new AppError('invalid-input', 'AI is off. Turn it on in Settings → AI.')
    if (settings.provider === 'chatgpt') {
      this.codexPath = settings.codexPath
      const codex = this.codex()
      if (!(await codex.account())) {
        throw new AppError(
          'invalid-input',
          'Sign in with ChatGPT first: Settings → AI → Continue with ChatGPT.',
        )
      }
      const model = settings.chatgptModel || undefined
      return { chat: (i) => codex.chat({ ...i, model }) }
    }
    const ollama = new Ollama(settings.host, this.options.fetchImpl)
    let model = settings.model
    if (!model) {
      const models = await ollama.models()
      if (!models.length) {
        throw new AppError(
          'invalid-input',
          'Ollama has no models installed yet. Install one with “ollama pull llama3.2”, then try again.',
        )
      }
      model = models[0]!
    }
    return { chat: (i) => ollama.chat({ ...i, model }) }
  }

  /** Codex, started when first needed (and restarted if its path setting changes). */
  private codexClient: { path: string; client: CodexClient } | null = null
  private codex(path = this.codexPath): CodexClient {
    if (!this.codexClient || this.codexClient.path !== path) {
      this.codexClient?.client.stop()
      this.codexClient = { path, client: new CodexClient(() => findCodex(path)) }
    }
    return this.codexClient.client
  }
  private codexPath = ''

  /** ChatGPT: sign in through Codex (opens OpenAI's page in the browser). */
  async chatgptSignIn(open: (url: string) => Promise<void>): Promise<void> {
    await this.refreshPath()
    await this.codex().signIn(open)
  }

  async chatgptSignOut(): Promise<void> {
    await this.refreshPath()
    await this.codex().signOut()
  }

  private async refreshPath() {
    this.codexPath = (await this.options.settings()).codexPath
  }

  /** Stops Codex when the app quits. */
  dispose(): void {
    this.codexClient?.client.stop()
  }

  /** Whether Ollama answers (at `host`, or the saved address) and with which models. */
  async status(
    shown: { host?: string; provider?: AiSettings['provider']; codexPath?: string } = {},
  ): Promise<AiStatus> {
    // What the settings page shows may be a moment ahead of what's saved.
    const settings = { ...(await this.options.settings()), ...shown }
    const host = shown.host
    this.codexPath = settings.codexPath
    if (settings.provider === 'chatgpt') return this.chatgptStatus(settings)
    const base = {
      enabled: settings.enabled,
      provider: 'ollama' as const,
      host: host ?? settings.host,
      account: null,
    }
    try {
      const models = await new Ollama(base.host, this.options.fetchImpl).models()
      const model =
        settings.model && models.includes(settings.model) ? settings.model : (models[0] ?? null)
      return { ...base, reachable: true, models, model, error: null }
    } catch (err) {
      return {
        ...base,
        reachable: false,
        models: [],
        model: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async chatgptStatus(settings: AiSettings): Promise<AiStatus> {
    const base = { enabled: settings.enabled, provider: 'chatgpt' as const, host: '' }
    const path = findCodex(settings.codexPath)
    if (!path) {
      return {
        ...base,
        reachable: false,
        models: [],
        model: null,
        account: null,
        error: CODEX_MISSING,
      }
    }
    try {
      const codex = this.codex()
      const account = await codex.account()
      const models = account ? (await codex.models().catch(() => [])).map((m) => m.id) : []
      return {
        ...base,
        reachable: true,
        models,
        model: settings.chatgptModel || models[0] || null,
        account,
        error: null,
      }
    } catch (err) {
      return {
        ...base,
        reachable: false,
        models: [],
        model: null,
        account: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort()
  }

  private async track<T>(requestId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.running.get(requestId)?.abort()
    this.running.set(requestId, controller)
    try {
      return await task(controller.signal)
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }

  /** Chat, brainstorm or ask the story; the answer streams to `onToken`. */
  async ask(input: AskInput, onToken: (text: string) => void): Promise<{ text: string }> {
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const context = await this.context(input, provider, signal)
      const text = await provider.chat({
        messages: chatMessages(context, input.messages),
        signal,
        onToken,
      })
      return { text }
    })
  }

  /** What the model reads: the scope, the entries named in it, and for questions the digest. */
  private async context(
    input: AskInput,
    provider: Provider,
    signal: AbortSignal,
  ): Promise<PromptContext> {
    const context: PromptContext = { mode: input.mode, scope: null, entries: [] }
    const scope = input.scope
    if (!scope) return context
    const library = this.options.host.current
    const chapter = await library.readChapter(scope.seriesId, scope.volumeId, scope.chapterId)
    let text = scope.text
    if (scope.kind === 'chapter') {
      const paragraphs = docParagraphs(chapter.content)
      text = paragraphs.join('\n\n')
      if (words(text) > CHAPTER_WORDS) text = await this.summarise(paragraphs, provider, signal)
    }
    context.scope = { kind: scope.kind, text, chapterTitle: chapter.title }

    const series = await library.getSeries(scope.seriesId)
    if (series.worldId) {
      const view = await library.world.view(series.worldId)
      const counts = new Map<string, number>()
      for (const m of nameMatcher(entryTerms(view.entries)).find(text)) {
        counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1)
      }
      const named = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES)
      for (const [entryId] of named) {
        const entry = await library.world.entryText(series.worldId, entryId).catch(() => '')
        if (entry) context.entries.push(entry.slice(0, MAX_ENTRY_CHARS))
      }
      if (input.mode === 'ask') {
        context.digest = (await library.world.digest(series.worldId)).slice(0, MAX_DIGEST_CHARS)
      }
    }
    return context
  }

  /** A long chapter, read in parts and summarised (the model can't take it all at once). */
  private async summarise(
    paragraphs: string[],
    provider: Provider,
    signal: AbortSignal,
  ): Promise<string> {
    const parts: string[][] = [[]]
    let count = 0
    for (const p of paragraphs) {
      if (count > CHAPTER_WORDS * 0.8 && parts[parts.length - 1]!.length) {
        parts.push([])
        count = 0
      }
      parts[parts.length - 1]!.push(p)
      count += words(p)
    }
    const summaries: string[] = []
    for (const [i, part] of parts.entries()) {
      const summary = await provider.chat({
        messages: summaryMessages(part.join('\n\n'), i + 1, parts.length),
        temperature: 0.2,
        signal,
      })
      summaries.push(`Part ${i + 1}: ${summary.trim()}`)
    }
    return `(The chapter is long, so this is a summary of it, part by part.)\n\n${summaries.join('\n\n')}`
  }

  /**
   * Spelling and grammar: corrected versions of the paragraphs, same count
   * and order. Paragraphs the model mangles come back unchanged.
   */
  async grammar(
    input: { requestId: string; paragraphs: string[]; worldId?: string | null },
    onProgress: (done: number, total: number) => void,
  ): Promise<{ paragraphs: string[] }> {
    const provider = await this.client()
    let names: string[] = []
    if (input.worldId) {
      const view = await this.options.host.current.world.view(input.worldId).catch(() => null)
      names = view ? view.entries.flatMap((e) => [e.name, ...e.aliases]) : []
    }
    return this.track(input.requestId, async (signal) => {
      const out = [...input.paragraphs]
      // Only paragraphs with words in them; scene breaks and blanks stay as they are.
      const todo = input.paragraphs.flatMap((p, i) => (/[\p{L}\p{N}]/u.test(p) ? [i] : []))
      const batches: number[][] = [[]]
      let size = 0
      for (const i of todo) {
        if (size > 0 && size + input.paragraphs[i]!.length > GRAMMAR_BATCH_CHARS) {
          batches.push([])
          size = 0
        }
        batches[batches.length - 1]!.push(i)
        size += input.paragraphs[i]!.length
      }
      let done = 0
      onProgress(0, todo.length)
      const fix = async (indexes: number[]): Promise<boolean> => {
        const texts = indexes.map((i) => input.paragraphs[i]!)
        const reply = await provider.chat({
          messages: grammarMessages(texts, names),
          json: true,
          temperature: 0,
          signal,
        })
        const fixed = parseGrammar(reply, texts.length)
        if (!fixed) return false
        indexes.forEach((i, k) => (out[i] = fixed[k]!))
        return true
      }
      for (const batch of batches) {
        if (!batch.length) continue
        if (!(await fix(batch)) && batch.length > 1) {
          // The model lost count: one paragraph at a time instead.
          for (const i of batch) await fix([i])
        }
        done += batch.length
        onProgress(done, todo.length)
      }
      return { paragraphs: out }
    })
  }
}
