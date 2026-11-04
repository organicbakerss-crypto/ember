/**
 * The AI layer: one place in the main process that talks to the model, so
 * features don't care which model answers (Ollama, or ChatGPT with your plan). It builds what
 * the model reads (the reading scope, the world entries named in it), streams
 * answers back to the window that asked, and can stop any request.
 *
 * Nothing here writes to the writer's text or world: answers and edits go
 * back to the window, and what the AI finds in a chapter goes to the inbox
 * (and its summary beside the chapter). Only the writer's own accept changes
 * anything.
 */
import { docParagraphs } from '@shared/analysis/doc'
import { entryTerms, nameMatcher } from '@shared/names'
import type { AiSettings } from '@shared/settings'
import type { AiStatus } from '@shared/ipc'
import { AppError } from '../errors'
import type { LibraryHost } from '../libraryHost'
import { chapterTextHash } from '../library/library'
import { Ollama, type ChatMessage } from './ollama'
import {
  chapterParts,
  checkFindings,
  combineMessages,
  entryNote,
  findingsMessages,
  NEW_KINDS,
  norm,
  parseFindings,
  parseSortedNames,
  sortNamesMessages,
  type Finding,
  type RawFindings,
} from './worldUpdate'
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
    /** The open chapter (none needed for the whole story). */
    volumeId: string | null
    chapterId: string | null
    /** The selection or what's on screen (for the whole chapter, read here). */
    text: string
  } | null
}

/** Whoever answers: Ollama or ChatGPT. */
interface Provider {
  kind: 'ollama' | 'chatgpt'
  chat(input: {
    messages: ChatMessage[]
    json?: boolean
    temperature?: number
    signal?: AbortSignal
    onToken?: (text: string) => void
  }): Promise<string>
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** How much of a chapter goes to the AI at once when reading it for the world. */
const READ_WORDS = { ollama: 1500, chatgpt: 12000 }
/** Most entries' notes sent with a chapter, and the other names listed. */
const MAX_NOTES = 12
const MAX_OTHER_NAMES = 400

export interface WorldUpdateResult {
  summary: string
  /** Changes the AI made itself (each in the inbox with Undo). */
  applied: number
  suggestions: number
  continuity: number
  questions: number
}

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
        kind: 'chatgpt',
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
      kind: 'ollama',
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
  async ask(
    input: AskInput,
    onToken: (text: string) => void,
    onProgress: (text: string) => void = () => {},
  ): Promise<{ text: string }> {
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const context = await this.context(input, provider, signal, onProgress)
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
    onProgress: (text: string) => void,
  ): Promise<PromptContext> {
    const context: PromptContext = { mode: input.mode, scope: null, entries: [] }
    const scope = input.scope
    if (!scope) return context
    const library = this.options.host.current
    let text = scope.text
    if (scope.kind === 'story') {
      const series = await library.getSeries(scope.seriesId)
      text = await this.storyText(scope.seriesId, provider, signal, onProgress)
      context.scope = { kind: 'story', text, chapterTitle: series.name }
    } else {
      if (!scope.volumeId || !scope.chapterId) {
        throw new AppError('invalid-input', 'Open a chapter for the AI to read.')
      }
      const chapter = await library.readChapter(scope.seriesId, scope.volumeId, scope.chapterId)
      if (scope.kind === 'chapter') {
        const paragraphs = docParagraphs(chapter.content)
        text = paragraphs.join('\n\n')
        if (words(text) > CHAPTER_WORDS) text = await this.summarise(paragraphs, provider, signal)
      }
      context.scope = { kind: scope.kind, text, chapterTitle: chapter.title }
    }

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
      if (input.mode === 'ask' || scope.kind === 'story') {
        context.digest = (await library.world.digest(series.worldId)).slice(0, MAX_DIGEST_CHARS)
      }
    }
    return context
  }

  /**
   * The whole story as chapter summaries, in order. Chapters without a
   * current summary are summarised first (and the summaries kept).
   */
  private async storyText(
    seriesId: string,
    provider: Provider,
    signal: AbortSignal,
    onProgress: (text: string) => void,
  ): Promise<string> {
    const library = this.options.host.current
    const all = await library.storySummaries(seriesId)
    const missing = all.filter((s) => !s.current && s.paragraphs.some((p) => p.trim()))
    const volumes = new Set(all.map((s) => s.chapter.volumeId)).size
    const lines: string[] = []
    let done = 0
    for (const s of all) {
      let summary = s.current ? s.summary : null
      if (!summary && missing.includes(s)) {
        done++
        onProgress(`Summarising chapters the AI hasn’t read yet (${done} of ${missing.length})…`)
        summary = await this.summariseChapter(s.chapter.title, s.paragraphs, provider, signal)
        if (summary) {
          await library.saveSummary(
            s.chapter.seriesId,
            s.chapter.volumeId,
            s.chapter.id,
            summary,
            s.textHash,
          )
        }
      }
      const where = volumes > 1 ? `${s.chapter.volumeName} › ` : ''
      lines.push(
        `${where}${s.chapter.label} “${s.chapter.title || 'Untitled'}”: ${summary ?? '(empty)'}`,
      )
    }
    onProgress('')
    return lines.join('\n\n')
  }

  /** One chapter's summary (in parts when it's long for this model). */
  private async summariseChapter(
    title: string,
    paragraphs: string[],
    provider: Provider,
    signal: AbortSignal,
  ): Promise<string> {
    const parts = chapterParts(paragraphs, READ_WORDS[provider.kind])
    const summaries: string[] = []
    for (const [i, part] of parts.entries()) {
      const reply = await provider.chat({
        messages: summaryMessages(
          `${i === 0 ? `(The chapter “${title || 'Untitled'}”)\n\n` : ''}${part}`,
          i + 1,
          parts.length,
        ),
        temperature: 0.2,
        signal,
      })
      if (reply.trim()) summaries.push(reply.trim())
    }
    if (summaries.length <= 1) return summaries[0] ?? ''
    return (
      await provider.chat({ messages: combineMessages(summaries), temperature: 0.2, signal })
    ).trim()
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

  /**
   * Reads a chapter for the world: its summary is kept beside the chapter,
   * and what the AI found (checked against the world) goes to the inbox.
   * `onProgress` gets a line for the writer as it goes.
   */
  async updateWorld(
    input: { requestId: string; seriesId: string; volumeId: string; chapterId: string },
    onProgress: (text: string) => void,
  ): Promise<WorldUpdateResult> {
    const provider = await this.client()
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    if (!series.worldId) {
      throw new AppError('invalid-input', 'This story has no world to update. Link one first.')
    }
    const worldId = series.worldId
    const chapter = await library.readChapter(input.seriesId, input.volumeId, input.chapterId)
    const paragraphs = docParagraphs(chapter.content)
    const text = paragraphs.join('\n\n')
    if (!text.trim()) throw new AppError('invalid-input', 'This chapter is empty.')
    const [view, answers] = await Promise.all([
      library.world.view(worldId),
      library.world.answers(worldId),
    ])

    // The entries named in the chapter, most mentioned first.
    const counts = new Map<string, number>()
    for (const m of nameMatcher(entryTerms(view.entries)).find(text)) {
      counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1)
    }
    const named = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_NOTES)
    const notes: string[] = []
    for (const [entryId] of named) {
      const entry = view.entries.find((e) => e.id === entryId)
      if (!entry) continue
      const template = view.templates.find((t) => t.id === entry.template)
      const note = await library.world.entryText(worldId, entryId).catch(() => '')
      if (note) {
        notes.push(
          template
            ? entryNote(note.slice(0, MAX_ENTRY_CHARS), template)
            : note.slice(0, MAX_ENTRY_CHARS),
        )
      }
    }
    const namedIds = new Set(named.map(([id]) => id))
    const otherNames = view.entries
      .filter((e) => !namedIds.has(e.id))
      .slice(0, MAX_OTHER_NAMES)
      .map((e) => e.name)

    return this.track(input.requestId, async (signal) => {
      const parts = chapterParts(paragraphs, READ_WORDS[provider.kind])
      const raws: RawFindings[] = []
      for (const [i, part] of parts.entries()) {
        onProgress(
          parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}…` : 'Reading the chapter…',
        )
        const reply = await provider.chat({
          messages: findingsMessages({
            chapterTitle: chapter.title,
            text: part,
            part: i + 1,
            parts: parts.length,
            notes,
            otherNames,
            relationshipTypes: view.relationshipTypes,
            answers,
          }),
          json: true,
          temperature: 0.2,
          signal,
        })
        const raw = parseFindings(reply)
        if (!raw) {
          throw new AppError(
            'invalid-input',
            'The AI’s answer couldn’t be read. Try again; a larger model does this better.',
          )
        }
        raws.push(raw)
      }
      let summary = raws[0]?.summary ?? ''
      if (raws.length > 1) {
        onProgress('Putting the summary together…')
        summary = (
          await provider.chat({
            messages: combineMessages(raws.map((r) => r.summary).filter(Boolean)),
            temperature: 0.2,
            signal,
          })
        ).trim()
      }
      onProgress('Checking what it found against the world…')
      const source = {
        seriesId: input.seriesId,
        volumeId: input.volumeId,
        chapterId: input.chapterId,
        chapterTitle: chapter.title,
      }
      const facts = (v: typeof view) => ({
        entries: v.entries,
        templates: v.templates,
        relationshipTypes: v.relationshipTypes,
        relationships: v.relationships,
        answered: answers.map((a) => a.question),
      })
      let findings = checkFindings(raws, text, facts(view))
      let applied = 0
      if ((await this.options.settings()).worldChanges !== 'suggest') {
        // The AI makes the changes itself; each is listed in the inbox with Undo.
        onProgress('Updating the world…')
        const made: Finding[] = []
        const apply = async (f: Finding) => {
          const done = await library.world.applySuggestion(worldId, f.suggestion!, source, f.quote)
          made.push({ ...f, kind: 'applied', entryId: done.entryId, undo: done.undo })
        }
        // New things first, so facts and relationships can name them too.
        for (const f of findings) if (f.suggestion?.type === 'new') await apply(f)
        if (made.length)
          findings = checkFindings(raws, text, facts(await library.world.view(worldId)))
        for (const f of findings) {
          if (f.kind === 'suggestion' && f.suggestion?.type !== 'new') await apply(f)
        }
        applied = made.length
        findings = [...made, ...findings.filter((f) => f.kind !== 'suggestion')]
      }
      if (summary) {
        await library.saveSummary(
          input.seriesId,
          input.volumeId,
          input.chapterId,
          summary,
          chapterTextHash(paragraphs),
        )
      }
      await library.world.addFindings(worldId, source, findings)
      return {
        summary,
        applied,
        suggestions: findings.filter((f) => f.kind === 'suggestion').length,
        continuity: findings.filter((f) => f.kind === 'continuity').length,
        questions: findings.filter((f) => f.kind === 'question').length,
      }
    })
  }

  /**
   * Sorts names the name catcher found: each becomes an entry of the right
   * kind (or a suggestion, if the AI only suggests), and what isn't a name
   * for the world is turned down. Everything it did is listed in the inbox.
   */
  async sortNames(
    input: {
      requestId: string
      worldId: string
      names: { name: string; quote: string; chapterId: string }[]
    },
    onProgress: (text: string) => void,
  ): Promise<{ applied: number; suggestions: number; skipped: number }> {
    const provider = await this.client()
    const library = this.options.host.current
    const apply = (await this.options.settings()).worldChanges !== 'suggest'
    const story = await library.worldStory(input.worldId)
    const chapters = new Map(story.map((s) => [s.chapter.id, s.chapter]))
    return this.track(input.requestId, async (signal) => {
      const sorted = new Map<string, { kind: string; about: string }>()
      const batches: (typeof input.names)[] = []
      for (let i = 0; i < input.names.length; i += 40) batches.push(input.names.slice(i, i + 40))
      for (const [i, batch] of batches.entries()) {
        onProgress(
          batches.length > 1 ? `Sorting names (${i + 1} of ${batches.length})…` : 'Sorting names…',
        )
        const reply = await provider.chat({
          messages: sortNamesMessages(batch),
          json: true,
          temperature: 0.1,
          signal,
        })
        for (const [k, v] of parseSortedNames(reply)) sorted.set(k, v)
      }
      const view = await library.world.view(input.worldId)
      const known = new Set(
        view.entries.flatMap((e) => [e.name, ...e.aliases]).map((n) => n.toLowerCase()),
      )
      const notNames: string[] = []
      let applied = 0
      let suggestions = 0
      for (const n of input.names) {
        const got = sorted.get(norm(n.name))
        if (!got) continue // Not sorted: stays in the list.
        if (got.kind === 'none') {
          notNames.push(n.name)
          continue
        }
        const kind = NEW_KINDS[got.kind]!
        if (known.has(n.name.toLowerCase())) continue
        if (!view.templates.some((t) => t.id === kind.template)) continue
        const chapter = chapters.get(n.chapterId)
        if (!chapter) continue
        const source = {
          seriesId: chapter.seriesId,
          volumeId: chapter.volumeId,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
        }
        const suggestion = {
          type: 'new' as const,
          name: n.name,
          template: kind.template,
          about: got.about.slice(0, 300),
        }
        const text = `New ${kind.label}: ${n.name}${suggestion.about ? ` — ${suggestion.about}` : ''}`
        const quote = n.quote || null
        if (apply) {
          const done = await library.world.applySuggestion(input.worldId, suggestion, source, quote)
          await library.world.addFindings(
            input.worldId,
            source,
            [{ kind: 'applied', text, quote, entryId: done.entryId, suggestion, undo: done.undo }],
            false,
          )
          applied++
        } else {
          await library.world.addFindings(
            input.worldId,
            source,
            [{ kind: 'suggestion', text, quote, entryId: null, suggestion }],
            false,
          )
          suggestions++
        }
        known.add(n.name.toLowerCase())
      }
      if (notNames.length) await library.world.rejectNames(input.worldId, notNames, true)
      return { applied, suggestions, skipped: notNames.length }
    })
  }
}
