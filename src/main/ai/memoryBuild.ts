/**
 * "Make nodes" in the background: reads conversations part by part into a
 * draft of the story's memory, saved after every part (on this computer
 * only), so closing the app loses nothing and the build can carry on. The
 * draft is only added to the memory when the writer keeps it.
 */
import fs from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  cutParts,
  identifyMessages,
  keepDraft,
  knownLabels,
  labelSummary,
  parseIdentify,
  parseSort,
  sortMessages,
  mergePart,
  parsePartReply,
  partMessages,
  type MemoryDraft,
  type SourceMessage,
} from '@shared/memory/build'
import { AppError } from '../errors'
import { writeJsonFile } from '../fs/jsonFile'
import type { LibraryHost } from '../libraryHost'
import type { ChatMessage } from './ollama'

export interface MemoryProvider {
  kind: 'ollama' | 'chatgpt'
  chat(input: {
    messages: ChatMessage[]
    json?: boolean
    temperature?: number
    signal?: AbortSignal
  }): Promise<string>
}

/** Words read at once. */
const PART_WORDS = { ollama: 2000, chatgpt: 9000 }
/** Topics listed to the AI so it adds to them rather than making new ones. */
const MAX_KNOWN = { ollama: 120, chatgpt: 400 }

const draftSchema = z.looseObject({ seriesId: z.string(), parts: z.array(z.unknown()) })

export class MemoryBuilds {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly deps: {
      host: LibraryHost
      client: () => Promise<MemoryProvider>
      onChange: (seriesId: string, draft: MemoryDraft | null) => void
    },
  ) {}

  private get library() {
    return this.deps.host.current
  }

  /** The draft for a story (a build that was running when the app closed reads as stopped). */
  async draft(seriesId: string): Promise<MemoryDraft | null> {
    const file = this.library.memoryDraftFile(seriesId)
    let raw: string
    try {
      raw = await fs.promises.readFile(file, 'utf8')
    } catch {
      return null
    }
    let draft: MemoryDraft
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!draftSchema.safeParse(parsed).success) throw new Error('shape')
      draft = parsed as MemoryDraft
    } catch {
      throw new AppError(
        'corrupt',
        'The draft of “Make nodes” can’t be read. Discard it to start again.',
      )
    }
    if (draft.state === 'running' && !this.running.has(seriesId)) {
      draft.state = 'stopped'
      draft.error = 'Stopped when the app closed. Continue to finish it.'
    }
    return draft
  }

  private async save(draft: MemoryDraft): Promise<void> {
    draft.updatedAt = new Date().toISOString()
    const file = this.library.memoryDraftFile(draft.seriesId)
    await fs.promises.mkdir(dirname(file), { recursive: true })
    await writeJsonFile(file, draft)
    this.deps.onChange(draft.seriesId, draft)
  }

  /** The messages a build reads, in order (only the dates asked for). */
  private async messages(draft: MemoryDraft): Promise<SourceMessage[]> {
    const out: SourceMessage[] = []
    for (const id of draft.conversationIds) {
      const c = await this.library.readConversation(draft.seriesId, id).catch(() => null)
      if (!c) continue
      for (const m of c.messages) {
        if (draft.from && m.at.slice(0, 10) < draft.from) continue
        if (draft.to && m.at.slice(0, 10) > draft.to) continue
        if (!m.content.trim()) continue
        out.push({
          role: m.role,
          content: m.content,
          at: m.at,
          conversationId: c.id,
          title: c.title,
        })
      }
    }
    return out
  }

  /** Starts a new build (replacing a draft only when asked to). */
  async start(input: {
    seriesId: string
    conversationIds: string[]
    instruction: string
    /** What the writer says about their story, to tell it apart. */
    clues?: string
    from: string | null
    to: string | null
  }): Promise<MemoryDraft> {
    if (this.running.has(input.seriesId)) {
      throw new AppError('conflict', 'Nodes are already being made for this story.')
    }
    const existing = await this.draft(input.seriesId).catch(() => null)
    if (existing && (existing.nodes.length || existing.loose.length)) {
      throw new AppError(
        'conflict',
        'There’s a draft from “Make nodes” waiting. Keep or discard it first.',
      )
    }
    await this.library.getSeries(input.seriesId)
    const provider = await this.deps.client()
    const now = new Date().toISOString()
    const draft: MemoryDraft = {
      seriesId: input.seriesId,
      instruction: input.instruction.trim(),
      conversationIds: input.conversationIds,
      from: input.from,
      to: input.to,
      forcedParts: [],
      clues: (input.clues ?? '').trim(),
      // First the whole conversation is sorted by story; nodes come after the writer checks it.
      phase: 'sorting',
      parts: [],
      nodes: [],
      loose: [],
      state: 'running',
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    const parts = cutParts(await this.messages(draft), PART_WORDS[provider.kind])
    if (!parts.length) {
      throw new AppError(
        'invalid-input',
        'Nothing to read: those conversations have no messages in those dates.',
      )
    }
    draft.parts = parts.map((p, index) => ({
      index,
      firstAt: p[0]!.at,
      lastAt: p[p.length - 1]!.at,
      words: p.reduce((n, m) => n + m.content.split(/\s+/).filter(Boolean).length, 0),
      status: 'pending',
      reason: '',
      // Plain words for the writer to check a skip (no Markdown marks).
      preview: p[0]!.content
        .replace(/\*\*|__|`|^#+\s*|:::\S*|\{[^}]*\}/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 280),
    }))
    await this.save(draft)
    void this.run(draft)
    return draft
  }

  /**
   * After sorting: makes nodes from the parts marked as the writer's story
   * (`mine`: the writer's marks; left out, the AI's).
   */
  async read(seriesId: string, mine?: number[]): Promise<MemoryDraft> {
    if (this.running.has(seriesId))
      throw new AppError('conflict', 'Still sorting; wait or stop it.')
    const draft = await this.draft(seriesId)
    if (!draft) throw new AppError('not-found', 'There’s no “Make nodes” draft.')
    if (mine) {
      const set = new Set(mine)
      for (const part of draft.parts) {
        const now = set.has(part.index)
        if (now !== !!part.mine) part.mineByWriter = true
        part.mine = now
      }
    }
    for (const part of draft.parts) {
      if (part.mine) {
        part.status = 'pending'
        part.reason = ''
      } else {
        part.status = 'skipped'
        part.reason = part.label
          ? `Sorted as “${part.label}”${part.about ? `: ${part.about}` : ''}`
          : 'Not marked as your story.'
      }
    }
    if (!draft.parts.some((p) => p.mine))
      throw new AppError('invalid-input', 'Mark at least one stretch as your story first.')
    draft.phase = 'reading'
    draft.state = 'running'
    draft.error = null
    await this.save(draft)
    void this.run(draft)
    return draft
  }

  /** Carries on a stopped build, or reads skipped parts the writer wants included. */
  async resume(seriesId: string, include: number[] = []): Promise<MemoryDraft> {
    if (this.running.has(seriesId)) return (await this.draft(seriesId))!
    const draft = await this.draft(seriesId)
    if (!draft) throw new AppError('not-found', 'There’s no “Make nodes” draft.')
    for (const i of include) {
      const part = draft.parts[i]
      if (!part || part.status === 'used') continue
      part.status = 'pending'
      if (!draft.forcedParts.includes(i)) draft.forcedParts.push(i)
    }
    for (const part of draft.parts) if (part.status === 'failed') part.status = 'pending'
    draft.state = 'running'
    draft.error = null
    await this.save(draft)
    void this.run(draft)
    return draft
  }

  cancel(seriesId: string): void {
    this.running.get(seriesId)?.abort()
  }

  private async run(draft: MemoryDraft): Promise<void> {
    const controller = new AbortController()
    this.running.set(draft.seriesId, controller)
    try {
      const provider = await this.deps.client()
      const series = await this.library.getSeries(draft.seriesId)
      const snapshot = await this.library.snapshot()
      const books =
        snapshot.series.find((s) => s.id === series.id)?.volumes.map((v) => v.name) ?? []
      const names = await this.storyNames(draft.seriesId, series.worldId ?? null)
      const parts = cutParts(await this.messages(draft), PART_WORDS[provider.kind])
      if ((draft.phase ?? 'reading') === 'sorting') {
        await this.sort(draft, parts, provider, controller.signal, {
          storyName: series.name,
          books,
          names,
        })
        return
      }
      const existing = (await this.library.listNodes(draft.seriesId)).nodes
      for (const info of draft.parts) {
        if (info.status !== 'pending') continue
        if (controller.signal.aborted) break
        const part = parts[info.index]
        if (!part) {
          info.status = 'failed'
          info.reason = 'That part of the conversation is gone.'
          continue
        }
        const known = [
          ...draft.nodes.map((n) => ({
            key: n.key,
            title: n.title,
            state: n.state,
            summary: n.summary,
          })),
          ...existing
            .filter((e) => !e.loose && !draft.nodes.some((d) => d.existingId === e.id))
            .map((e) => ({ key: e.id, title: e.title, state: e.state, summary: e.summary })),
        ].slice(0, MAX_KNOWN[provider.kind])
        const messages = partMessages({
          instruction: draft.instruction,
          storyName: series.name,
          books,
          names,
          known,
          part,
          index: info.index,
          total: draft.parts.length,
          // Parts the writer's story was found in (or they marked) are read for it, never skipped.
          forced: draft.forcedParts.includes(info.index) || !!info.mine,
          identity: [draft.identity, draft.clues].filter(Boolean).join(' '),
        })
        let reply = null
        for (let attempt = 0; attempt < 2 && !reply; attempt++) {
          try {
            reply = parsePartReply(
              await provider.chat({
                messages,
                json: true,
                temperature: 0.2,
                signal: controller.signal,
              }),
            )
          } catch (err) {
            if (controller.signal.aborted) break
            info.reason = err instanceof Error ? err.message.slice(0, 300) : 'The AI didn’t answer.'
          }
        }
        if (controller.signal.aborted) break
        if (!reply) {
          info.status = 'failed'
          info.reason ||= 'The AI’s answer couldn’t be read.'
        } else if (!reply.relevant && !draft.forcedParts.includes(info.index) && !info.mine) {
          info.status = 'skipped'
          info.reason = reply.reason || 'Didn’t fit what you asked for.'
        } else {
          mergePart(draft, reply, part, existing)
          info.status = 'used'
          info.reason = ''
        }
        await this.save(draft)
      }
      draft.state = controller.signal.aborted ? 'stopped' : 'done'
      if (controller.signal.aborted)
        draft.error = 'Stopped. Continue to finish it, or keep what’s found so far.'
      await this.save(draft)
    } catch (err) {
      draft.state = 'failed'
      draft.error = err instanceof Error ? err.message : 'Something went wrong.'
      await this.save(draft).catch(() => {})
    } finally {
      this.running.delete(draft.seriesId)
    }
  }

  /** Names from the story's chapters (titles, POVs) and its world: clues for telling it apart. */
  private async storyNames(seriesId: string, worldId: string | null): Promise<string[]> {
    const names = new Set<string>()
    if (worldId) {
      const view = await this.library.world.view(worldId).catch(() => null)
      for (const e of view?.entries ?? []) names.add(e.name)
    }
    const snapshot = await this.library.snapshot()
    for (const v of snapshot.series.find((s) => s.id === seriesId)?.volumes ?? []) {
      const outline = await this.library.getOutline(seriesId, v.id).catch(() => null)
      for (const c of Object.values(outline?.chapters ?? {})) {
        if (c.title) names.add(c.title)
        for (const p of c.povs ?? []) if (p.name) names.add(p.name)
        if (c.pov) names.add(c.pov)
      }
    }
    return [...names].slice(0, 400)
  }

  /**
   * Pass 1: labels every part by the story or project it's about, then (with
   * the whole conversation in view) decides which labels are the writer's
   * story. Stops for the writer to check.
   */
  private async sort(
    draft: MemoryDraft,
    parts: SourceMessage[][],
    provider: MemoryProvider,
    signal: AbortSignal,
    story: { storyName: string; books: string[]; names: string[] },
  ): Promise<void> {
    for (const info of draft.parts) {
      if (info.label) continue
      if (signal.aborted) break
      const part = parts[info.index]
      if (!part) continue
      let sorted = null
      for (let attempt = 0; attempt < 2 && !sorted; attempt++) {
        try {
          sorted = parseSort(
            await provider.chat({
              messages: sortMessages({
                part,
                index: info.index,
                total: draft.parts.length,
                labels: knownLabels(draft.parts),
              }),
              json: true,
              temperature: 0.1,
              signal,
            }),
          )
        } catch (err) {
          if (signal.aborted) break
          info.reason = err instanceof Error ? err.message.slice(0, 300) : 'The AI didn’t answer.'
        }
      }
      if (signal.aborted) break
      if (sorted) {
        info.label = sorted.label
        info.about = sorted.about
        info.names = sorted.names
        info.reason = ''
      } else {
        info.label = 'not sorted'
        info.reason ||= 'The AI’s answer couldn’t be read.'
      }
      await this.save(draft)
    }
    if (signal.aborted) {
      draft.state = 'stopped'
      draft.error = 'Stopped while sorting. Continue to finish it.'
      await this.save(draft)
      return
    }
    // The whole conversation in view: which labels are the writer's story.
    const labels = labelSummary(draft.parts)
    const found = await (async () => {
      try {
        return parseIdentify(
          await provider.chat({
            messages: identifyMessages({
              instruction: draft.instruction,
              clues: draft.clues ?? '',
              ...story,
              labels,
            }),
            json: true,
            temperature: 0.1,
            signal,
          }),
        )
      } catch {
        return null
      }
    })()
    const story_ = story.storyName.toLowerCase()
    const known = new Set(story.names.map((n) => n.toLowerCase()))
    for (const part of draft.parts) {
      if (part.mineByWriter) continue
      const byAi = found?.labels[part.label ?? '']
      // Without the AI's call: a label named like the story, or sharing its names.
      part.mine =
        byAi ??
        (!!part.label &&
          (part.label.toLowerCase().includes(story_) ||
            (part.names ?? []).some((n) => known.has(n.toLowerCase()))))
    }
    draft.identity = found?.identity ?? ''
    draft.phase = 'sorted'
    draft.state = 'done'
    draft.error = null
    await this.save(draft)
  }

  /** Adds the draft (or the chosen topics of it) to the story's memory, then clears it. */
  async keep(seriesId: string, only?: string[]): Promise<{ nodes: number }> {
    if (this.running.has(seriesId)) throw new AppError('conflict', 'Stop the build first.')
    const draft = await this.draft(seriesId)
    if (!draft) throw new AppError('not-found', 'There’s no “Make nodes” draft.')
    const { nodes: existing, problems } = await this.library.listNodes(seriesId)
    if (problems.length) {
      throw new AppError(
        'corrupt',
        `Some memory files can’t be read (${problems[0]!.path}), so nothing was added. Fix or remove them first.`,
      )
    }
    const snapshot = await this.library.snapshot()
    const books = snapshot.series.find((s) => s.id === seriesId)?.volumes ?? []
    const nodes = keepDraft(draft, existing, books, only ? new Set(only) : undefined)
    await this.library.saveNodes(seriesId, nodes)
    await this.discard(seriesId)
    return { nodes: nodes.length }
  }

  async discard(seriesId: string): Promise<void> {
    this.cancel(seriesId)
    await fs.promises.rm(this.library.memoryDraftFile(seriesId), { force: true })
    this.deps.onChange(seriesId, null)
  }
}
