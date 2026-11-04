/**
 * The AI layer: one place in the main process that talks to the model, so
 * features don't care which model answers (Ollama, or ChatGPT with your plan). It builds what
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
import { ChatGpt, type SecretBox } from './chatgpt'

/** Used when ChatGPT doesn't list its models and none is chosen. */
const DEFAULT_CHATGPT_MODEL = 'gpt-6.1-sol'
import {
  chatMessages,
  editMessages,
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

/** Whoever answers: Ollama or ChatGPT. */
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

  private readonly chatgpt: ChatGpt

  constructor(
    private readonly options: {
      settings: () => Promise<AiSettings>
      host: LibraryHost
      fetchImpl?: typeof fetch
      /** Give up on a request after this long with nothing arriving (tests make it short). */
      idleMs?: number
      /** ChatGPT: where its login is kept, and how it's encrypted. */
      chatgpt: { file: string; secrets: SecretBox; authBase?: string; answersBase?: string }
    },
  ) {
    this.chatgpt = new ChatGpt({ ...options.chatgpt, fetchImpl: options.fetchImpl })
  }

  private async client(): Promise<Provider> {
    const settings = await this.options.settings()
    if (!settings.enabled)
      throw new AppError('invalid-input', 'AI is off. Turn it on in Settings → AI.')
    if (settings.provider === 'chatgpt') {
      if (!(await this.chatgpt.account())) {
        throw new AppError(
          'invalid-input',
          'Sign in with ChatGPT first: Settings → AI → Continue with ChatGPT.',
        )
      }
      const model =
        settings.chatgptModel || (await this.chatgpt.models())[0] || DEFAULT_CHATGPT_MODEL
      return {
        chat: (i) => this.chatgpt.chat({ ...i, model, idleMs: this.options.idleMs }),
      }
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
    return {
      chat: (i) => ollama.chat({ ...i, model, idleMs: this.options.idleMs }),
    }
  }

  /** ChatGPT: sign in (opens OpenAI's page in the browser and waits for it). */
  chatgptSignIn(open: (url: string) => Promise<void>): Promise<void> {
    return this.chatgpt.signIn(open)
  }

  chatgptSignOut(): Promise<void> {
    return this.chatgpt.signOut()
  }

  dispose(): void {
    this.chatgpt.cancelSignIn()
  }

  /** Whether the AI can answer, and with which models. */
  async status(
    shown: { host?: string; provider?: AiSettings['provider'] } = {},
  ): Promise<AiStatus> {
    // What the settings page shows may be a moment ahead of what's saved.
    const settings = { ...(await this.options.settings()), ...shown }
    if (settings.provider === 'chatgpt') return this.chatgptStatus(settings)
    const base = {
      enabled: settings.enabled,
      provider: 'ollama' as const,
      host: shown.host ?? settings.host,
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
    try {
      const account = await this.chatgpt.account()
      const models = account ? await this.chatgpt.models().catch(() => []) : []
      return {
        ...base,
        reachable: true,
        models,
        model: settings.chatgptModel || models[0] || (account ? DEFAULT_CHATGPT_MODEL : null),
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
   * Edits the open chapter as asked: the chapter goes as Markdown, the whole
   * edited chapter comes back (streamed to `onToken`). Nothing is written here:
   * the window puts it in, keeps the versions and shows what changed.
   */
  async editChapter(
    input: {
      requestId: string
      seriesId: string
      instruction: string
      chapterTitle: string
      chapter: string
      messages: { role: 'user' | 'assistant'; content: string }[]
    },
    onToken: (text: string) => void,
  ): Promise<{ text: string }> {
    const provider = await this.client()
    let names: string[] = []
    const series = await Promise.resolve()
      .then(() => this.options.host.current.getSeries(input.seriesId))
      .catch(() => null)
    if (series?.worldId) {
      const view = await this.options.host.current.world.view(series.worldId).catch(() => null)
      names = view ? view.entries.flatMap((e) => [e.name, ...e.aliases]) : []
    }
    return this.track(input.requestId, async (signal) => {
      const text = await provider.chat({
        messages: editMessages({
          instruction: input.instruction,
          chapterTitle: input.chapterTitle,
          chapter: input.chapter,
          history: input.messages,
          names,
        }),
        temperature: 0.2,
        signal,
        onToken,
      })
      if (!text.trim()) throw new AppError('invalid-input', 'The AI sent back nothing. Try again.')
      return { text }
    })
  }
}
