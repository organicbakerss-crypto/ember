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
import { findPassages, pickSummaries, searchTerms, storyParts, type LookupChapter } from './lookup'
import { entryTerms, nameMatcher } from '@shared/names'
import type { AiSettings } from '@shared/settings'
import type { AiStatus } from '@shared/ipc'
import { AppError } from '../errors'
import type { LibraryHost } from '../libraryHost'
import { chapterTextHash } from '../library/library'
import type { ChapterSpeakersFile, Speaker } from '@shared/schema'
import type { EntrySummary } from '@shared/ipc'
import type { Segment } from '@shared/voice/script'
import type { StorySummary } from '../library/library'
import { audiobookScript, docBlocks, segments } from '@shared/voice/script'
import { numberedParts, parseSpeakers, resolveSpeaker, speakersMessages } from './speakers'
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
  notesMessages,
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
  /** The story asked about (also when nothing in it is being read). */
  seriesId?: string
  /** Files the writer attached to the conversation, as text. */
  attachments?: { name: string; text: string }[]
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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const clipWords = (s: string, n: number) => {
  const all = s.split(/(\s+)/)
  return all.length > n * 2 ? `${all.slice(0, n * 2).join('')} […]` : s
}

/** How much goes to each kind of model (in words, or counts). */
const LIMITS = {
  ollama: {
    fullStory: 5000,
    readPart: 2500,
    attachment: 3000,
    beforeChapter: 1500,
    summaries: 8,
    passages: 6,
  },
  chatgpt: {
    fullStory: 90000,
    readPart: 40000,
    attachment: 30000,
    beforeChapter: 8000,
    summaries: 20,
    passages: 16,
  },
}

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
  ): Promise<{ text: string; lookedAt: string[] }> {
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const lookedAt: string[] = []
      const context = await this.context(input, provider, signal, onProgress, lookedAt)
      onProgress('')
      const text = await provider.chat({
        messages: chatMessages(context, input.messages),
        signal,
        onToken,
      })
      return { text, lookedAt }
    })
  }

  /** The story's chapters in order, with their summaries, for looking things up. */
  private async lookupChapters(seriesId: string): Promise<(LookupChapter & { id: string })[]> {
    const all = await this.options.host.current.storySummaries(seriesId)
    const volumes = new Set(all.map((s) => s.chapter.volumeId)).size
    return all.map((s) => ({
      id: s.chapter.id,
      label: `${volumes > 1 ? `${s.chapter.volumeName} › ` : ''}${s.chapter.label}`,
      title: s.chapter.title,
      paragraphs: s.paragraphs,
      summary: s.current ? s.summary : null,
    }))
  }

  /**
   * What the model reads: the scope, the entries named in it, files attached,
   * and (so it never answers blind) what it looked up for the question:
   * chapter summaries first, then the world, then passages of the story.
   */
  private async context(
    input: AskInput,
    provider: Provider,
    signal: AbortSignal,
    onProgress: (text: string) => void,
    lookedAt: string[],
  ): Promise<PromptContext> {
    const context: PromptContext = { mode: input.mode, scope: null, entries: [] }
    const scope = input.scope
    const seriesId = scope?.seriesId ?? input.seriesId
    const limit = LIMITS[provider.kind]
    if (input.attachments?.length) {
      context.attachments = input.attachments.map((a) => ({
        name: a.name,
        text: clipWords(a.text, limit.attachment),
      }))
      lookedAt.push(`attached: ${input.attachments.map((a) => a.name).join(', ')}`)
    }
    if (!seriesId) return context
    const library = this.options.host.current
    const series = await library.getSeries(seriesId)
    const question = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    let text = scope?.text ?? ''
    let chapters: (LookupChapter & { id: string })[] | null = null
    const story = async () => (chapters ??= await this.lookupChapters(seriesId))

    if (scope?.kind === 'story') {
      text = await this.storyText(seriesId, provider, signal, onProgress)
      context.scope = { kind: 'story', text, chapterTitle: series.name }
      lookedAt.push('every chapter’s summary')
    } else if (scope?.kind === 'full') {
      const all = await story()
      const total = all.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + words(p), 0), 0)
      if (total <= limit.fullStory) {
        text = storyParts(all, Number.MAX_SAFE_INTEGER).join('\n\n')
        lookedAt.push(`the whole story word for word (~${total.toLocaleString('en')} words)`)
      } else {
        const parts = storyParts(all, limit.readPart)
        let notes = ''
        for (const [i, part] of parts.entries()) {
          onProgress(`Reading the whole story: part ${i + 1} of ${parts.length}…`)
          notes = (
            await provider.chat({
              messages: notesMessages(question, notes, part, i + 1, parts.length),
              temperature: 0.2,
              signal,
            })
          ).trim()
        }
        text = notes
        context.readInParts = true
        lookedAt.push(
          `the whole story in ${parts.length} parts with running notes (~${total.toLocaleString('en')} words)`,
        )
      }
      context.scope = { kind: 'full', text, chapterTitle: series.name }
    } else if (scope) {
      if (!scope.volumeId || !scope.chapterId) {
        throw new AppError('invalid-input', 'Open a chapter for the AI to read.')
      }
      const chapter = await library.readChapter(seriesId, scope.volumeId, scope.chapterId)
      if (scope.kind === 'chapter') {
        const paragraphs = docParagraphs(chapter.content)
        text = paragraphs.join('\n\n')
        if (words(text) > CHAPTER_WORDS) text = await this.summarise(paragraphs, provider, signal)
      }
      context.scope = { kind: scope.kind, text, chapterTitle: chapter.title }
      lookedAt.push(
        scope.kind === 'chapter'
          ? `“${chapter.title || 'Untitled'}”`
          : `${scope.kind === 'selection' ? 'your selection' : 'what’s on screen'} in “${chapter.title || 'Untitled'}”`,
      )
      // Brainstorming: the two chapters before it too.
      if (input.mode === 'brainstorm') {
        const all = await story()
        const at = all.findIndex((c) => c.id === scope.chapterId)
        context.before = all.slice(Math.max(0, at - 2), Math.max(0, at)).map((c) => ({
          title: `${c.label} “${c.title || 'Untitled'}”`,
          text: clipWords(c.paragraphs.join('\n\n'), limit.beforeChapter),
        }))
        if (context.before.length) lookedAt.push(`the ${context.before.length} chapters before it`)
      }
    }

    // The world: entries named in the text and the question; the digest for questions.
    let names: string[] = []
    if (series.worldId) {
      const view = await library.world.view(series.worldId)
      names = view.entries.flatMap((e) => [e.name, ...(e.aliases ?? [])])
      const counts = new Map<string, number>()
      const matcher = nameMatcher(entryTerms(view.entries))
      // Named in the question first: that's what the writer is asking about.
      for (const m of matcher.find(question))
        counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1000)
      for (const m of matcher.find(text)) counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1)
      const named = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES)
      for (const [entryId] of named) {
        const entry = await library.world.entryText(series.worldId, entryId).catch(() => '')
        if (entry) context.entries.push(entry.slice(0, MAX_ENTRY_CHARS))
      }
      if (context.entries.length)
        lookedAt.push(plural(context.entries.length, 'world entry', 'world entries'))
      if (input.mode === 'ask' || scope?.kind === 'story' || scope?.kind === 'full' || !scope) {
        context.digest = (await library.world.digest(series.worldId)).slice(0, MAX_DIGEST_CHARS)
        lookedAt.push('the world overview')
      }
    }

    // Look up the question in the summaries and the story itself (not needed when it read it all).
    if (scope?.kind !== 'story' && scope?.kind !== 'full' && question.trim()) {
      onProgress('Looking through the story…')
      const all = await story()
      const terms = searchTerms(question, names)
      const summaries = pickSummaries(all, terms, limit.summaries)
      const passages = findPassages(all, terms, limit.passages)
      if (summaries.length || passages.length) context.lookup = { summaries, passages }
      if (summaries.length)
        lookedAt.push(plural(summaries.length, 'chapter summary', 'chapter summaries'))
      if (passages.length) lookedAt.push(plural(passages.length, 'passage', 'passages'))
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

  /**
   * The audiobook script for a chapter, a volume or the whole story: who says
   * each line is marked by the AI (only for chapters changed since they were
   * last marked), narration goes to the chapter's narrator.
   */
  async voiceScript(
    input: {
      requestId: string
      seriesId: string
      volumeId: string | null
      chapterId: string | null
    },
    onProgress: (text: string) => void,
  ): Promise<{ script: string; title: string; chapters: number; lines: number }> {
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    const view = series.worldId ? await library.world.view(series.worldId) : null
    const entries = view?.entries ?? []
    const all = (await library.storySummaries(input.seriesId)).filter(
      (s) =>
        (!input.chapterId || s.chapter.id === input.chapterId) &&
        (!input.volumeId || s.chapter.volumeId === input.volumeId),
    )
    if (!all.length) throw new AppError('invalid-input', 'There are no chapters to read.')
    let provider: Promise<Provider> | null = null
    return this.track(input.requestId, async (signal) => {
      const chapters: Parameters<typeof audiobookScript>[0] = []
      let lineCount = 0
      for (const [i, s] of all.entries()) {
        const { seriesId, volumeId, id: chapterId } = s.chapter
        const chapter = await library.readChapter(seriesId, volumeId, chapterId)
        const segs = segments(docBlocks(chapter.content))
        const pov = chapter.povEntryId
          ? (entries.find((e) => e.id === chapter.povEntryId) ?? null)
          : null
        const povSpeaker = pov
          ? { entryId: pov.id, name: pov.name }
          : chapter.pov
            ? { entryId: null, name: chapter.pov }
            : null
        const marked = await this.markSpeakers(
          { series, entries, chapter, summary: s, segs, povSpeaker },
          () => (provider ??= this.client()),
          signal,
          () => onProgress(`Marking who speaks (chapter ${i + 1} of ${all.length})…`),
        )
        const narratorTag = marked.narrator?.name || 'Narrator'
        const lines = segs.map((seg) => ({
          kind: seg.kind,
          text: seg.text,
          voice:
            seg.kind === 'quote'
              ? (seg.key && marked.lines[seg.key]?.name) || 'Other'
              : narratorTag,
        }))
        lineCount += lines.filter((l) => l.kind !== 'break').length
        chapters.push({
          heading: `${s.chapter.label}${chapter.title ? `: ${chapter.title}` : ''}`,
          lines,
        })
      }
      const one = input.chapterId ? all[0]!.chapter : null
      return {
        script: audiobookScript(chapters),
        title: one ? one.title || one.label : series.name,
        chapters: chapters.length,
        lines: lineCount,
      }
    })
  }

  /** A chapter's synopsis: its AI summary, made (and kept) now if missing or out of date. */
  async chapterSynopsis(input: {
    requestId: string
    seriesId: string
    volumeId: string
    chapterId: string
  }): Promise<string> {
    const library = this.options.host.current
    const s = (await library.storySummaries(input.seriesId)).find(
      (x) => x.chapter.id === input.chapterId,
    )
    if (!s) throw new AppError('not-found', 'That chapter is gone.')
    if (s.current && s.summary) return s.summary
    if (!s.paragraphs.some((p) => p.trim())) {
      throw new AppError('invalid-input', 'This chapter has no text to summarise yet.')
    }
    const summary = await this.track(input.requestId, async (signal) =>
      this.summariseChapter(s.chapter.title, s.paragraphs, await this.client(), signal),
    )
    if (!summary) throw new AppError('internal', 'The AI sent back nothing.')
    await library.saveSummary(input.seriesId, input.volumeId, input.chapterId, summary, s.textHash)
    return summary
  }

  /**
   * Who says each line of a chapter, by line key, and who tells it (for
   * reading aloud). Without the AI, the saved marking if it's current, else
   * only the POV as narrator.
   */
  async chapterSpeakers(
    input: { requestId: string; seriesId: string; volumeId: string; chapterId: string },
    onProgress: (text: string) => void,
  ): Promise<{ narrator: string | null; lines: Record<string, string> }> {
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    const entries = series.worldId ? (await library.world.view(series.worldId)).entries : []
    const summary = (await library.storySummaries(input.seriesId)).find(
      (x) => x.chapter.id === input.chapterId,
    )
    if (!summary) throw new AppError('not-found', 'That chapter is gone.')
    const chapter = await library.readChapter(input.seriesId, input.volumeId, input.chapterId)
    const pov = chapter.povEntryId ? entries.find((e) => e.id === chapter.povEntryId) : null
    const povSpeaker = pov
      ? { entryId: pov.id, name: pov.name }
      : chapter.pov
        ? { entryId: null, name: chapter.pov }
        : null
    const aiOn = (await this.options.settings()).enabled
    const saved = await library.readSpeakers(input.seriesId, input.volumeId, input.chapterId)
    const marked =
      saved?.textHash === summary.textHash || !aiOn
        ? saved
        : await this.track(input.requestId, (signal) =>
            this.markSpeakers(
              {
                series,
                entries,
                chapter,
                summary,
                segs: segments(docBlocks(chapter.content)),
                povSpeaker,
              },
              () => this.client(),
              signal,
              () => onProgress('Marking who speaks…'),
            ),
          )
    const lines: Record<string, string> = {}
    for (const [k, v] of Object.entries(marked?.lines ?? {})) if (v.name) lines[k] = v.name
    return { narrator: marked?.narrator?.name ?? null, lines }
  }

  /**
   * Who says each line in a chapter, and who tells it: the saved marking, or
   * the AI asked again when the chapter changed since. A chapter that reads as
   * told by someone other than its POV is flagged in the inbox.
   */
  private async markSpeakers(
    ctx: {
      series: { id: string; worldId: string | null }
      entries: EntrySummary[]
      chapter: { id: string; title: string }
      summary: StorySummary
      segs: Segment[]
      povSpeaker: Speaker | null
    },
    getProvider: () => Promise<Provider>,
    signal: AbortSignal,
    onMarking: () => void,
  ): Promise<ChapterSpeakersFile> {
    const library = this.options.host.current
    const { series, entries, chapter, segs, povSpeaker } = ctx
    const s = ctx.summary
    const { seriesId, volumeId, id: chapterId } = s.chapter
    let marked = await library.readSpeakers(seriesId, volumeId, chapterId)
    if (!marked || marked.textHash !== s.textHash) {
      onMarking()
      const provider = await getProvider()
      const parts = numberedParts(segs, READ_WORDS[provider.kind])
      let narratorName = ''
      const byNumber = new Map<number, string>()
      let offset = 0
      for (const part of parts) {
        if (part.count || !narratorName) {
          const reply = await provider.chat({
            messages: speakersMessages({
              chapterTitle: chapter.title,
              text: part.text,
              cast: entries.map((e) => e.name).slice(0, 200),
              pov: povSpeaker?.name ?? null,
            }),
            json: true,
            temperature: 0.1,
            signal,
          })
          const got = parseSpeakers(reply)
          narratorName ||= got.narrator
          // Numbers run through the whole chapter; a part may number from 1 again.
          for (const [n, name] of got.speakers) {
            byNumber.set(n > offset ? n : n + offset, name)
          }
        }
        offset += part.count
      }
      const aiNarrator = narratorName ? resolveSpeaker(narratorName, entries, null) : null
      const narrator = povSpeaker && aiNarrator ? povSpeaker : aiNarrator
      const lines: Record<string, Speaker> = {}
      let n = 0
      for (const seg of segs) {
        if (seg.kind !== 'quote') continue
        n++
        const who = resolveSpeaker(byNumber.get(n) ?? '', entries, narrator)
        if (who && seg.key) lines[seg.key] = who
      }
      // The writer's fixes win, and are kept for next time.
      const fixed = marked?.fixed ?? {}
      for (const [k, v] of Object.entries(fixed)) lines[k] = v
      marked = {
        formatVersion: 1,
        chapterId,
        textHash: s.textHash,
        narrator,
        lines,
        fixed,
        createdAt: new Date().toISOString(),
      }
      await library.saveSpeakers(seriesId, volumeId, marked)
      // Told by someone other than the POV says: say so (nothing is changed).
      if (
        series.worldId &&
        povSpeaker?.entryId &&
        aiNarrator?.entryId &&
        aiNarrator.entryId !== povSpeaker.entryId
      ) {
        await library.world.addFindings(
          series.worldId,
          { seriesId, volumeId, chapterId, chapterTitle: chapter.title },
          [
            {
              kind: 'continuity',
              text: `“${chapter.title || 'Untitled'}” reads as told by ${aiNarrator.name}, but its POV is ${povSpeaker.name}. The audio uses ${povSpeaker.name}; change the POV if that’s wrong.`,
              quote: null,
              entryId: aiNarrator.entryId,
            },
          ],
          false,
        )
      }
    }
    return marked
  }
}
