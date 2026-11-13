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
import { isIndividual } from '@shared/world/templates'
import {
  findParagraphPrompt,
  paragraphProbe,
  parseChapterMatches,
  parseParagraph,
  pickChaptersPrompt,
} from '@shared/ai/findScene'
import type { SceneHit, SearchHit } from '@shared/ipc'
import { notesParts, pageNotesPrompt, parsePageNotes, type PageNote } from '@shared/ai/pageNotes'
import {
  parseSelectionAnswer,
  selectionPrompt,
  type SelectionAction,
  type SelectionAnswer,
} from '@shared/ai/selection'
import { docParagraphs } from '@shared/analysis/doc'
import { roundtableRole } from '@shared/ai/roundtableCast'
import { WRITER_LEARNERS, persona, slopGuidance } from '@shared/ai/personas'
import { MAX_LEARNED, learnMessages, parseLearned } from './learn'
import {
  CHARACTER_TEMPLATE,
  storyCharacterInstructions,
  templateName,
} from '@shared/ai/storyCharacters'
import type { AiCharacterFile } from '@shared/schema'
import {
  finalPosition,
  finalPositionsReady,
  nextParticipant,
  validBallot,
  type RoundtableSession,
} from '@shared/ai/roundtable'
import { findPassages, pickSummaries, searchTerms, storyParts, type LookupChapter } from './lookup'
import {
  SharedChatError,
  chatPieces,
  pickChatPieces,
  shareIdOf,
  shareUrl,
  sharedChatFromHtml,
  type ChatPiece,
} from '@shared/ai/sharedChat'
import { newId } from '@shared/ids'
import type { ConversationFile } from '@shared/schema'
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
  /** Captured at conversation creation; independent of later settings changes. */
  characterId?: string
  /** The story asked about (also when nothing in it is being read). */
  seriesId?: string
  /** Files the writer attached to the conversation, as text. */
  attachments?: { name: string; text: string }[]
  /** The chapter the writer has open: a story character knows nothing after it. */
  cutoffChapterId?: string | null
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
/** Chapters up to and including the open one (all of them when there's none). */
function cutAt<T extends { id: string }>(chapters: T[], cutoffChapterId?: string | null): T[] {
  if (!cutoffChapterId) return chapters
  const at = chapters.findIndex((c) => c.id === cutoffChapterId)
  return at < 0 ? chapters : chapters.slice(0, at + 1)
}
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
    chatPieces: 4,
    chatPieceChars: 1200,
  },
  chatgpt: {
    fullStory: 90000,
    readPart: 40000,
    attachment: 30000,
    beforeChapter: 8000,
    summaries: 20,
    passages: 16,
    chatPieces: 12,
    chatPieceChars: 4000,
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
  /** Imported chats cut into pieces, by conversation (redone when the chat changes). */
  private readonly pieces = new Map<string, { updatedAt: string; pieces: ChatPiece[] }>()

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
      /** Saves what an adaptive character has learned. */
      saveLearned?: (characterId: string, notes: string[]) => Promise<void>
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

  /**
   * Brings in a ChatGPT chat from its share link, as a read-only conversation
   * of the story. The same link again updates the chat brought in before.
   */
  async importChat(
    seriesId: string,
    url: string,
  ): Promise<{ conversationId: string; title: string; messages: number; updated: boolean }> {
    const shareId = shareIdOf(url)
    if (!shareId) {
      throw new AppError(
        'invalid-input',
        'That isn’t a ChatGPT share link. In ChatGPT, use Share → Copy link; it starts with https://chatgpt.com/share/.',
      )
    }
    const library = this.options.host.current
    await library.getSeries(seriesId)
    const fetchImpl = this.options.fetchImpl ?? fetch
    let html: string
    try {
      const res = await fetchImpl(shareUrl(shareId), {
        headers: { accept: 'text/html', 'accept-language': 'en' },
        signal: AbortSignal.timeout(60_000),
      })
      if (res.status === 404)
        throw new AppError('not-found', 'That shared chat is gone (the link was deleted).')
      if (!res.ok)
        throw new AppError('internal', `ChatGPT didn’t send the chat (HTTP ${res.status}).`)
      html = await res.text()
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError('internal', 'Couldn’t reach ChatGPT. Check the internet connection.')
    }
    let chat
    try {
      chat = sharedChatFromHtml(html, shareId)
    } catch (err) {
      if (err instanceof SharedChatError) throw new AppError('invalid-input', err.message)
      throw err
    }
    const existing = (await library.importedChats(seriesId)).find(
      (c) => c.source?.shareId === shareId,
    )
    const now = new Date().toISOString()
    const conversation: ConversationFile = {
      ...(existing ?? {}),
      formatVersion: 1,
      id: existing?.id ?? newId('conversation'),
      mode: 'chat',
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      source: { kind: 'chatgpt-share', shareId, url: shareUrl(shareId), importedAt: now },
      messages: chat.messages.map((m) => ({
        role: m.role,
        content: m.text,
        at: m.at,
        read: null,
      })),
    }
    await library.saveConversation(seriesId, conversation)
    return {
      conversationId: conversation.id,
      title: chat.title,
      messages: chat.messages.length,
      updated: !!existing,
    }
  }

  /** The pieces of a story's imported ChatGPT chats that touch the question. */
  private async chatLookup(
    seriesId: string,
    terms: string[],
    limit: (typeof LIMITS)[keyof typeof LIMITS],
  ): Promise<{ pieces: ChatPiece[]; chats: number }> {
    const chats = await this.options.host.current.importedChats(seriesId)
    if (!chats.length || !terms.length) return { pieces: [], chats: 0 }
    const all: ChatPiece[] = []
    for (const c of chats) {
      let known = this.pieces.get(c.id)
      if (known?.updatedAt !== c.updatedAt) {
        known = { updatedAt: c.updatedAt, pieces: chatPieces(c) }
        this.pieces.set(c.id, known)
      }
      all.push(...known.pieces)
    }
    const pieces = pickChatPieces(all, terms, limit.chatPieces, limit.chatPieceChars)
    return { pieces, chats: new Set(pieces.map((p) => p.where.split('”,')[0])).size }
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
      const settings = await this.options.settings()
      const characterId = input.characterId ?? settings.characterId
      // One of the writer's own story characters: only the story up to the open chapter.
      const storyCharacter = characterId.startsWith('chr_')
        ? await this.storyCharacter(input.seriesId ?? input.scope?.seriesId, characterId)
        : null
      const context = await this.context(
        { ...input, cutoffChapterId: storyCharacter ? (input.cutoffChapterId ?? null) : null },
        provider,
        signal,
        onProgress,
        lookedAt,
      )
      context.characterId = characterId
      if (storyCharacter) {
        const order = await this.chapterOrder(storyCharacter.seriesId)
        const cut = input.cutoffChapterId ? order.indexOf(input.cutoffChapterId) : -1
        const learned = storyCharacter.file.learned
          .filter((n) => cut < 0 || !n.chapterId || order.indexOf(n.chapterId) <= cut)
          .map((n) => n.text)
        context.storyCharacter = {
          name: storyCharacter.file.name,
          instructions: storyCharacterInstructions(
            storyCharacter.file.name,
            storyCharacter.file.card,
            settings.adaptive ? learned : [],
          ),
        }
      } else {
        const id = persona(context.characterId).id
        if (settings.adaptive && persona(id).adaptive) context.learned = settings.learned[id] ?? []
      }
      onProgress('')
      const text = await provider.chat({
        messages: chatMessages(context, input.messages),
        signal,
        onToken,
      })
      return { text, lookedAt }
    })
  }

  /** Figurehead: retrieve evidence from the actual project, then write a grounded common brief. */
  async prepareRoundtable(
    seriesId: string,
    session: RoundtableSession,
    requestId: string,
  ): Promise<NonNullable<RoundtableSession['briefing']>> {
    const library = this.options.host.current
    const series = await library.getSeries(seriesId)
    const chapters = await library.storySummaries(seriesId)
    const terms =
      session.topic
        .toLowerCase()
        .match(/[a-z]{3,}/g)
        ?.filter(
          (term) =>
            !new Set([
              'the',
              'and',
              'that',
              'this',
              'with',
              'from',
              'what',
              'where',
              'should',
              'would',
              'could',
              'here',
              'there',
              'about',
              'into',
              'your',
              'story',
            ]).has(term),
        ) ?? []
    const relevance = (text: string) =>
      terms.reduce((n, word) => n + (text.toLowerCase().includes(word) ? 1 : 0), 0)
    const sorted = chapters
      .map((chapter, index) => ({
        chapter,
        index,
        score: relevance(chapter.paragraphs.join(' ') + ' ' + (chapter.summary ?? '')),
      }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
    // Keep matched scenes and recent story events, with source labels. Never silently treat stale summaries as canon.
    const picked = sorted.filter((x) => x.score > 0).slice(0, 9)
    for (const recent of sorted
      .slice()
      .sort((a, b) => b.index - a.index)
      .slice(0, 3)) {
      if (!picked.some((x) => x.index === recent.index)) picked.push(recent)
    }
    const sources: string[] = []
    const evidence: string[] = []
    for (const { chapter } of picked.slice(0, 12)) {
      const label = `${chapter.chapter.volumeName} / ${chapter.chapter.title || chapter.chapter.label}`
      sources.push(label)
      const matching = chapter.paragraphs
        .map((text, index) => ({ text, index, score: relevance(text) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 7)
      const excerpts = matching.length
        ? matching.sort((a, b) => a.index - b.index)
        : chapter.paragraphs.slice(-5).map((text, index) => ({ text, index, score: 0 }))
      const excerpt = excerpts
        .map((p) => p.text)
        .join('\n')
        .slice(0, 4200)
      evidence.push(
        `SOURCE: ${label}\n${chapter.current && chapter.summary ? `Current chapter summary: ${chapter.summary.slice(0, 650)}\n` : ''}Manuscript excerpt: ${excerpt}`,
      )
    }
    if (series.worldId) {
      const world = await library.world.view(series.worldId)
      const entries = world.entries
        .map((entry) => ({
          entry,
          score: relevance(entry.name + ' ' + entry.aliases.join(' ') + ' ' + entry.snippet),
        }))
        .sort((a, b) => b.score - a.score)
        .filter((x) => x.score > 0)
        .slice(0, 8)
      for (const { entry } of entries) {
        const label = `World entry: ${entry.name}`
        sources.push(label)
        const notes = await library.world
          .entryText(series.worldId, entry.id)
          .catch(() => entry.snippet)
        evidence.push(`SOURCE: ${label}\n${notes.slice(0, 1700)}`)
      }
      if (!entries.length) {
        const digest = await library.world.digest(series.worldId).catch(() => '')
        if (digest) {
          sources.push('World overview')
          evidence.push(`SOURCE: World overview\n${digest.slice(0, 2600)}`)
        }
      }
    }
    const provider = await this.client()
    // Local models need a substantially smaller retrieval payload than ChatGPT.
    const corpus = evidence.join('\n\n').slice(0, provider.kind === 'ollama' ? 8500 : 26000)
    return this.track(requestId, async (signal) => {
      const prepared = await provider.chat({
        messages: [
          {
            role: 'system',
            content: [
              'You are the Figurehead, a neutral context librarian and moderator for a creative-writing Roundtable.',
              'Produce a concise, factual shared briefing grounded ONLY in the labeled manuscript and worldbuilding material supplied.',
              "Explain the writer's actual question, relevant established events and character constraints, and uncertainties. Separate canon from possible directions.",
              "Do not invent plot, claim missing information is established, rewrite the author's question, recommend a winner, or evaluate artistic merit.",
              'If the manuscript contains little or no relevant information, explicitly say this; do not manufacture context.',
              'Include the supplied source names alongside factual points when practical. The participants may propose changes to canon.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Writer question: ${session.topic}\n\nEvidence from project “${series.name}”:\n${corpus || '(No manuscript or worldbuilding text was available.)'}\n\nProduce the shared briefing.`,
          },
        ],
        signal,
        temperature: 0.2,
      })
      return {
        text: prepared.trim().slice(0, provider.kind === 'ollama' ? 5500 : 12000),
        sources: sources.slice(0, 80).map((x) => x.slice(0, 300)),
        preparedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * The Figurehead's neutral summary after the vote: where the table agreed,
   * where it split and why, and ideas worth keeping from proposals that
   * didn't win. It never picks a winner.
   */
  async summarizeRoundtable(session: RoundtableSession, requestId: string): Promise<string> {
    const finals = session.participants
      .map((p) => {
        const f = finalPosition(session, p.id)
        return f ? `${p.name}:\nIn short: ${f.summary}\n${f.text.slice(0, 4000)}` : ''
      })
      .filter(Boolean)
      .join('\n\n---\n\n')
    const provider = await this.client()
    return this.track(requestId, async (signal) =>
      (
        await provider.chat({
          messages: [
            {
              role: 'system',
              content: [
                'You are the Figurehead, the neutral moderator of a Roundtable on a writer’s story. Everyone has locked in a final proposal. Write a short, plain summary for the writer:',
                '- what most of them agreed on;',
                '- where they really split, and why (name who stood where);',
                '- good ideas from proposals that probably won’t win, worth keeping anyway.',
                'Don’t pick a winner and don’t add ideas of your own. Plain paragraphs, no headings. Name participants as they’re named below.',
                slopGuidance(),
              ].join('\n'),
            },
            {
              role: 'user',
              content: `The writer’s question: ${session.topic}\n\nFinal proposals:\n\n${finals.slice(0, 40000)}`,
            },
          ],
          temperature: 0.3,
          signal,
        })
      ).trim(),
    )
  }

  /** A single Roundtable contribution. The renderer controls phase transitions and saves history. */
  async roundtableTurn(input: {
    requestId: string
    session: RoundtableSession
    speakerId: string
    targetId: string | null
    direct: boolean
  }): Promise<{ text: string; ranking: string[] | null; summary?: string }> {
    const { session, speakerId, targetId, direct } = input
    const speaker = session.participants.find((p) => p.id === speakerId)
    if (!speaker) throw new AppError('invalid-input', 'Unknown Roundtable participant.')
    let roleInstructions: string
    try {
      roleInstructions = roundtableRole(speaker.id, speaker.kind).instructions
      for (const member of session.participants) roundtableRole(member.id, member.kind)
    } catch {
      throw new AppError('invalid-input', 'A selected Roundtable participant is not installed yet.')
    }
    if (session.phase === 'complete')
      throw new AppError('invalid-input', 'This session is complete.')
    if (direct) {
      if (!['discussion1', 'discussion2'].includes(session.phase)) {
        throw new AppError('invalid-input', 'Direct exchanges are available during discussions.')
      }
      if (
        !targetId ||
        targetId === speakerId ||
        !session.participants.some((p) => p.id === targetId)
      ) {
        throw new AppError('invalid-input', 'Select another participant to address.')
      }
    } else if (nextParticipant(session)?.id !== speakerId) {
      throw new AppError('invalid-input', 'It is another participant’s turn.')
    }

    const participants = session.participants.map((p) => `${p.name} [${p.id}]`).join(', ')
    // Final proposals stay hidden from competitors until all are locked.
    // Ballot text stays hidden from everyone until the entire vote is finished.
    if (session.phase === 'vote' && !finalPositionsReady(session)) {
      throw new AppError(
        'invalid-input',
        'Every participant must lock a final position before voting.',
      )
    }
    const transcript = session.posts
      .filter(
        (p) =>
          p.channel === 'user' ||
          p.channel === 'open' ||
          p.channel === 'direct' ||
          (p.channel === 'private' && p.speakerId === speakerId && p.phase !== 'final') ||
          (p.phase === 'final' && session.phase === 'vote' && !!p.summary),
      )
      .slice(-65)
      .map((p) => {
        const author =
          session.participants.find((person) => person.id === p.speakerId)?.name ?? 'Writer'
        const to = p.targetId
          ? ` to ${session.participants.find((person) => person.id === p.targetId)?.name ?? 'participant'}`
          : ''
        return `[${p.phase} / ${p.channel}] ${author}${to}: ${p.text.slice(0, 2200)}`
      })
      .join('\n\n')
      .slice(-22000)
    // Preserve the participant's own position even when a long discussion has
    // pushed its opening contribution out of the limited transcript window.
    const ownProposal = session.posts.find(
      (p) => p.speakerId === speakerId && p.phase === 'proposals' && p.channel === 'open',
    )
    const ownRevision = session.posts.find(
      (p) => p.speakerId === speakerId && p.phase === 'revision' && p.channel === 'private',
    )
    const positionMemory = [
      ownProposal
        ? `Your original proposal (your own, not a group consensus): ${ownProposal.text.slice(0, 3500)}`
        : '',
      ownRevision ? `Your private reconsideration: ${ownRevision.text.slice(0, 2500)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const role = direct
      ? `Reply directly to ${session.participants.find((p) => p.id === targetId)!.name}, about one real disagreement or question between you. Take their point seriously; if your idea still holds up, say why and what it costs. A short reply, not a new pitch.`
      : session.phase === 'proposals'
        ? 'Make your own proposal for the writer’s question: specific, in a few paragraphs at most. Then say briefly what you think a good answer has to do, so others can be judged against it.'
        : session.phase === 'discussion1'
          ? 'Respond to something specific another participant said. If your idea still holds up, defend it and say why theirs fits this story less well. If they made a fair point, say so; that doesn’t mean dropping your whole idea. Change your mind only for a good reason, not to agree.'
          : session.phase === 'revision'
            ? 'Privately, for yourself only: what were the best objections to your proposal? Which parts of it still stand, what would you change, and why? Keep what’s distinctive about your idea unless the objections really beat it.'
            : session.phase === 'discussion2'
              ? 'Continue the discussion from where you now stand. Take on one serious objection, say what still works about your idea and what weakness you accept, and push back on another proposal if it deserves it. Don’t just repeat your pitch, and don’t invent a disagreement.'
              : session.phase === 'final'
                ? 'Privately lock in the proposal you would actually recommend now, after both discussions. Don’t give up a good idea just because others preferred another one; do change it if the arguments really showed it was wrong. Reply ONLY with JSON: {"summary":"one or two plain sentences: the direction you propose","proposal":"your full final proposal, with reasons, consequences and caveats"}. Nobody sees it until everyone has locked theirs.'
                : `Everyone has locked in a final proposal. Rank the OTHER participants’ final proposals, best first, judging only the final versions. Never rank yourself. Reply ONLY with JSON: {"ranking":["id1","id2"]}, listing every other participant once. Their ids: ${session.participants
                    .filter((p) => p.id !== speakerId)
                    .map((p) => p.id)
                    .join(', ')}.`
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const response = await provider.chat({
        messages: [
          {
            role: 'system',
            content: [
              roleInstructions,
              ...(session.phase === 'vote' || session.phase === 'final' ? [] : [slopGuidance()]),
              'You’re one voice at a Roundtable about the writer’s story. The others are separate people; speak only for yourself, and don’t invent quotes or results.',
              'Think for yourself rather than going along with the room. Take criticism seriously but don’t give in to it automatically; defend what’s good about your idea and admit what it costs. Not stubborn, not combative: the point is to keep good competing ideas alive until the end.',
              ...(positionMemory ? [positionMemory] : []),
              `Roundtable participants: ${participants}.`,
              `Topic from the writer: ${session.topic}`,
              `What the story actually says, gathered by the Figurehead (proposals may deliberately change it): ${session.briefing?.text || 'No briefing is available; don’t assume facts about the story.'}`,
              `Current phase: ${session.phase}.`,
              role,
            ].join('\n\n'),
          },
          {
            role: 'user',
            content: `Roundtable discussion so far:\n${transcript || '(none yet)'}\n\nYour contribution now:`,
          },
        ],
        signal,
        temperature: session.phase === 'vote' ? 0.1 : 0.65,
        json: session.phase === 'vote' || session.phase === 'final',
      })
      if (session.phase === 'final' && !direct) {
        let result: { summary?: unknown; proposal?: unknown }
        try {
          result = JSON.parse(response.slice(response.indexOf('{'), response.lastIndexOf('}') + 1))
        } catch {
          throw new AppError(
            'invalid-input',
            'Could not read the sealed final proposal. Retry this participant.',
          )
        }
        if (
          typeof result.summary !== 'string' ||
          !result.summary.trim() ||
          typeof result.proposal !== 'string' ||
          !result.proposal.trim()
        ) {
          throw new AppError(
            'invalid-input',
            'A final proposal needs both a summary and its complete position.',
          )
        }
        return {
          text: result.proposal.trim().slice(0, 16000),
          summary: result.summary.trim().slice(0, 1800),
          ranking: null,
        }
      }
      if (session.phase !== 'vote' || direct) return { text: response.trim(), ranking: null }
      let ranking: unknown
      try {
        const json = JSON.parse(
          response.slice(response.indexOf('{'), response.lastIndexOf('}') + 1),
        ) as { ranking?: unknown }
        ranking = json.ranking
      } catch {
        throw new AppError(
          'invalid-input',
          'Could not read this participant’s ranking. Retry their ballot.',
        )
      }
      if (
        !Array.isArray(ranking) ||
        !ranking.every((id) => typeof id === 'string') ||
        !validBallot(session, speakerId, ranking)
      ) {
        throw new AppError(
          'invalid-input',
          'This ballot must rank every other participant once, without self-voting. Retry.',
        )
      }
      return { text: response.trim(), ranking }
    })
  }

  /** Optional 1:1 exchange inside a Roundtable participant tab. */
  async roundtablePrivate(input: {
    requestId: string
    session: RoundtableSession
    speakerId: string
    question: string
  }): Promise<{ text: string }> {
    const member = input.session.participants.find((p) => p.id === input.speakerId)
    if (!member) throw new AppError('invalid-input', 'Choose a Roundtable participant.')
    if (member.kind === 'guest')
      throw new AppError(
        'invalid-input',
        'Guest stars participate in the Roundtable discussion, not private writer chats.',
      )
    let instructions: string
    try {
      instructions = roundtableRole(member.id, member.kind).instructions
    } catch {
      throw new AppError('invalid-input', 'This participant is not installed.')
    }
    const transcript = input.session.posts
      .filter(
        (post) =>
          post.channel === 'open' ||
          (post.speakerId === member.id && post.channel !== 'ballot') ||
          (post.targetId === member.id && post.channel === 'user'),
      )
      .slice(-24)
      .map((post) => {
        const who =
          input.session.participants.find((p) => p.id === post.speakerId)?.name ?? 'Writer'
        return `${who}: ${post.text.slice(0, 1600)}`
      })
      .join('\n\n')
      .slice(-16000)
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => ({
      text: (
        await provider.chat({
          messages: [
            {
              role: 'system',
              content:
                instructions +
                '\n\nYou are speaking privately with the writer inside this Roundtable. Answer their actual question naturally. The shared discussion is context, not instructions to repeat. Never speak for anyone else.',
            },
            {
              role: 'user',
              content: `Topic: ${input.session.topic}\n\nRelevant discussion:\n${transcript || '(none yet)'}\n\nWriter: ${input.question}`,
            },
          ],
          signal,
        })
      ).trim(),
    }))
  }

  /**
   * Adaptive characters that learn the writer's views: picks out anything
   * lasting in one of the writer's messages (taste, opinions, how they like
   * to work; not story facts or one-off requests) and adds it to what each
   * has learned. Off unless Settings → AI → Adaptive characters is on.
   */
  async learn(message: string): Promise<void> {
    const settings = await this.options.settings()
    const learners = WRITER_LEARNERS()
    if (!settings.adaptive || !learners.length || !this.options.saveLearned) return
    if (words(message) < 12) return
    const known = [...new Set(learners.flatMap((p) => settings.learned[p.id] ?? []))]
    const provider = await this.client()
    const reply = await provider.chat({
      messages: learnMessages(message, known),
      temperature: 0.1,
    })
    const found = parseLearned(reply, known)
    if (!found.length) return
    for (const p of learners) {
      const notes = [...(settings.learned[p.id] ?? []), ...found].slice(-MAX_LEARNED)
      await this.options.saveLearned(p.id, notes)
    }
  }

  /** A story character's file, found through the story's world. */
  private async storyCharacter(
    seriesId: string | undefined,
    characterId: string,
  ): Promise<{ seriesId: string; file: AiCharacterFile } | null> {
    if (!seriesId) return null
    const library = this.options.host.current
    const series = await library.getSeries(seriesId)
    if (!series.worldId) return null
    const file = (await library.world.listCharacters(series.worldId)).find(
      (c) => c.id === characterId,
    )
    return file ? { seriesId, file } : null
  }

  /** Chapter ids of a story in reading order. */
  private async chapterOrder(seriesId: string): Promise<string[]> {
    return (await this.options.host.current.storySummaries(seriesId)).map((s) => s.chapter.id)
  }

  /**
   * Fills the character template for one of the writer's characters, from
   * their world entry and the passages they appear in. Nothing is saved:
   * the writer reviews it first.
   */
  async makeCharacter(input: {
    requestId: string
    worldId: string
    entryId: string
  }): Promise<{ name: string; card: string }> {
    const library = this.options.host.current
    const worldId = input.worldId
    const view = await library.world.view(worldId)
    const entry = view.entries.find((e) => e.id === input.entryId)
    if (!entry) throw new AppError('not-found', 'That entry no longer exists.')
    const notes = await library.world.entryText(worldId, entry.id).catch(() => '')
    // The story of every series this world belongs to.
    const all: (LookupChapter & { id: string })[] = []
    for (const s of (await library.snapshot()).series.filter((s) => s.worldId === worldId)) {
      all.push(...(await this.lookupChapters(s.id)))
    }
    const terms = [entry.name, ...(entry.aliases ?? [])].map((t) => t.toLowerCase())
    const provider = await this.client()
    const passages = findPassages(all, terms, provider.kind === 'chatgpt' ? 40 : 14, 900)
    return this.track(input.requestId, async (signal) => {
      const reply = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `Fill in this template for ${entry.name}, a character from the writer's own story, so an AI can speak as them. Use only what the notes and passages show; where they say nothing, keep the answer short or write "not clear yet" rather than inventing. For "Lines in their voice", copy real lines of their dialogue from the passages. Reply with the filled template only, keeping every label exactly as it is.\n\n${CHARACTER_TEMPLATE}`,
          },
          {
            role: 'user',
            content: `World notes on ${entry.name}:\n${notes.slice(0, 6000) || '(none)'}\n\nPassages they appear in:\n${passages.join('\n\n') || '(none found)'}`,
          },
        ],
        temperature: 0.3,
        signal,
      })
      const card = reply.trim()
      return { name: templateName(card) ?? entry.name, card }
    })
  }

  /**
   * AI notes on a chapter: read in parts with what the world says about who's
   * named and the earlier chapters' summaries; notes quote the exact words.
   */
  async pageNotes(
    input: {
      requestId: string
      seriesId: string
      chapterId: string
      title: string
      paragraphs: string[]
    },
    onProgress: (text: string) => void,
  ): Promise<{ notes: PageNote[] }> {
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    const text = input.paragraphs.join('\n').toLowerCase()
    let world = ''
    if (series.worldId) {
      const view = await library.world.view(series.worldId)
      const named = view.entries
        .filter((e) =>
          [e.name, ...(e.aliases ?? [])].some(
            (n) => n.length > 1 && text.includes(n.toLowerCase()),
          ),
        )
        .slice(0, 12)
      const parts: string[] = []
      for (const e of named) {
        const notes = await library.world.entryText(series.worldId, e.id).catch(() => e.snippet)
        parts.push(`${e.name}: ${notes.replace(/\s+/g, ' ').slice(0, 700)}`)
      }
      world = parts.join('\n')
    }
    const chapters = await this.lookupChapters(input.seriesId)
    const at = chapters.findIndex((c) => c.id === input.chapterId)
    const earlier = (at >= 0 ? chapters.slice(0, at) : [])
      .filter((c) => c.summary)
      .slice(-20)
      .map((c) => `${c.label}: ${c.summary}`)
      .join('\n')
    const parts = notesParts(input.paragraphs)
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const notes: PageNote[] = []
      for (const [i, part] of parts.entries()) {
        onProgress(parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}…` : 'Reading…')
        const { system, user } = pageNotesPrompt({
          part,
          partNumber: i + 1,
          parts: parts.length,
          chapterTitle: input.title,
          world,
          earlier,
        })
        const reply = await provider.chat({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          json: true,
          temperature: 0.2,
          signal,
        })
        notes.push(...parsePageNotes(reply, part))
      }
      return { notes }
    })
  }

  /**
   * Finds a scene the writer describes: the likely chapters (from summaries
   * and passages with the same words), then the paragraph in each, located
   * on the page with Find so it can be opened there.
   */
  async findScene(
    input: { requestId: string; seriesId: string; description: string },
    onProgress: (text: string) => void,
  ): Promise<{ hits: SceneHit[]; unread: number }> {
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    const all = await library.storySummaries(input.seriesId)
    const volumes = new Set(all.map((s) => s.chapter.volumeId)).size
    const chapters = all.map((s, i) => ({
      ref: `C${i + 1}`,
      id: s.chapter.id,
      volumeId: s.chapter.volumeId,
      label: `${volumes > 1 ? `${s.chapter.volumeName} › ` : ''}${s.chapter.label}`,
      title: s.chapter.title,
      paragraphs: s.paragraphs,
      summary: s.current ? s.summary : null,
    }))
    const names = series.worldId
      ? (await library.world.view(series.worldId)).entries.flatMap((e) => [e.name, ...e.aliases])
      : []
    const terms = searchTerms(input.description, names)
    const scored = chapters.map((c, i) => {
      const passages = terms.length
        ? findPassages([{ ...c, summary: null }], terms, 2, 300).map((p) =>
            p.replace(/^\([^)]*\)\s*/, ''),
          )
        : []
      const t = `${c.title} ${c.summary ?? ''}`.toLowerCase()
      const score = terms.filter((w) => t.includes(w)).length + passages.length
      return { c, i, passages, score }
    })
    // Every chapter when there aren't many; else the 40 that share the most words.
    const picked = (
      scored.length <= 60
        ? scored
        : [...scored]
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .slice(0, 40)
            .sort((a, b) => a.i - b.i)
    ).filter((x) => x.c.summary || x.passages.length || scored.length <= 60)
    const unread = chapters.filter((c) => !c.summary).length
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      onProgress('Looking through the chapters…')
      const pick = pickChaptersPrompt(
        input.description,
        picked.map(({ c, passages }) => ({
          ref: c.ref,
          label: c.label,
          title: c.title,
          summary: c.summary,
          passages,
        })),
      )
      const reply = await provider.chat({
        messages: [
          { role: 'system', content: pick.system },
          { role: 'user', content: pick.user },
        ],
        json: true,
        temperature: 0.1,
        signal,
      })
      const matches = parseChapterMatches(reply, new Set(picked.map((x) => x.c.ref)))
      const hits: SceneHit[] = []
      for (const [n, m] of matches.entries()) {
        const c = chapters.find((x) => x.ref === m.ref)!
        onProgress(`Reading ${c.label} (${n + 1} of ${matches.length})…`)
        const find = findParagraphPrompt(
          input.description,
          `${c.label} “${c.title || 'Untitled'}”`,
          c.paragraphs,
        )
        const answer = parseParagraph(
          await provider.chat({
            messages: [
              { role: 'system', content: find.system },
              { role: 'user', content: find.user },
            ],
            json: true,
            temperature: 0.1,
            signal,
          }),
          find.shown,
        )
        let hit: SearchHit | null = null
        let excerpt = ''
        if (answer) {
          const paragraph = c.paragraphs[answer.paragraph] ?? ''
          excerpt = paragraph.length > 220 ? `${paragraph.slice(0, 219)}…` : paragraph
          for (const words of [6, 3]) {
            const probe = paragraphProbe(paragraph, words)
            if (!probe) break
            const found = await library
              .searchVolume(input.seriesId, c.volumeId, probe, {
                matchCase: true,
                wholeWord: false,
              })
              .catch(() => null)
            hit = found?.hits.find((h) => h.chapterId === c.id) ?? null
            if (hit) break
          }
        }
        hits.push({
          volumeId: c.volumeId,
          chapterId: c.id,
          chapterName: `${c.label} “${c.title || 'Untitled'}”`,
          why: answer?.why || m.why,
          excerpt,
          hit,
        })
      }
      return { hits, unread }
    })
  }

  /** AI on selected text: a few options (or a note) for the writer to pick from. */
  async selection(input: {
    requestId: string
    action: SelectionAction
    text: string
    before: string
    after: string
    character?: { worldId: string; characterId: string }
  }): Promise<SelectionAnswer> {
    let character: { name: string; card: string } | undefined
    if (input.character) {
      const file = (
        await this.options.host.current.world.listCharacters(input.character.worldId)
      ).find((c) => c.id === input.character!.characterId)
      if (!file) throw new AppError('not-found', 'That character no longer exists.')
      character = { name: file.name, card: file.card }
    }
    const req = { ...input, character }
    const { system, user } = selectionPrompt(req)
    const provider = await this.client()
    return this.track(input.requestId, async (signal) => {
      const reply = await provider.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        json: true,
        temperature: input.action === 'fix' ? 0.1 : 0.7,
        signal,
      })
      return parseSelectionAnswer(reply, req)
    })
  }

  /**
   * Adaptive story characters: after a chapter is read for the world, each
   * character who appears in it picks up what happened to them there (what
   * they did, learned or decided, how they changed). Off unless Settings →
   * AI → Adaptive characters is on.
   */
  async learnFromChapter(input: {
    seriesId: string
    volumeId: string
    chapterId: string
  }): Promise<void> {
    const settings = await this.options.settings()
    if (!settings.adaptive) return
    const library = this.options.host.current
    const series = await library.getSeries(input.seriesId)
    if (!series.worldId) return
    const characters = await library.world.listCharacters(series.worldId)
    if (!characters.length) return
    const chapter = await library.readChapter(input.seriesId, input.volumeId, input.chapterId)
    const text = docParagraphs(chapter.content).join('\n\n')
    const provider = await this.client()
    for (const c of characters) {
      if (!text.toLowerCase().includes(c.name.toLowerCase())) continue
      const reply = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `From this chapter of the writer's story, note what happened to ${c.name}: what they did, learned or decided, and how they or their relationships changed. One to three short lines in the third person, only what this chapter shows. If they barely appear, reply exactly NONE.`,
          },
          {
            role: 'user',
            content: `Chapter “${chapter.title || 'Untitled'}”:\n\n${text.slice(0, provider.kind === 'chatgpt' ? 60000 : 12000)}`,
          },
        ],
        temperature: 0.2,
      })
      const notes = parseLearned(reply, [])
      if (notes.length) {
        await library.world.learnForCharacter(series.worldId, c.id, input.chapterId, notes)
      }
    }
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
    const story = async () =>
      (chapters ??= cutAt(await this.lookupChapters(seriesId), input.cutoffChapterId))

    if (scope?.kind === 'story') {
      text = await this.storyText(seriesId, provider, signal, onProgress, input.cutoffChapterId)
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

    // The writer's earlier ChatGPT chats about this story, when any were brought in.
    if (question.trim()) {
      const chats = await this.chatLookup(seriesId, searchTerms(question, names), limit)
      if (chats.pieces.length) {
        context.chats = chats.pieces
        lookedAt.push(
          `${plural(chats.pieces.length, 'part', 'parts')} of your ChatGPT ${chats.chats === 1 ? 'chat' : 'chats'}`,
        )
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
    cutoffChapterId?: string | null,
  ): Promise<string> {
    const library = this.options.host.current
    const all = cutAt(
      (await library.storySummaries(seriesId)).map((x) => ({ ...x, id: x.chapter.id })),
      cutoffChapterId,
    )
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
    const entries = view ? view.entries.filter((e) => isIndividual(view.templates, e.template)) : []
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
    // Only someone can speak or narrate (not a group, a place or a thing).
    const view = series.worldId ? await library.world.view(series.worldId) : null
    const entries = view ? view.entries.filter((e) => isIndividual(view.templates, e.template)) : []
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
