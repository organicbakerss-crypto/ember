/**
 * Voice in the main process: VoiceStudio's voices and speech-to-text, when
 * it's running. Speech made is kept on this computer (in the library's local
 * folder, never synced) by its text and voice, so reading again is instant
 * and an edit only re-makes what changed.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STUDIO_URL, type VoiceSettings } from '@shared/settings'
import { cleanDictation } from '@shared/voice/dictation'
import { writeFileAtomic } from '../fs/atomicWrite'
import { sha256 } from '../fs/jsonFile'
import { AppError } from '../errors'
import type { LibraryHost } from '../libraryHost'
import { VoiceStudio, type StudioVoice } from './studio'

const STEPS = { fast: 8, balanced: 16, best: 32 } as const
const VOICES_FOR_MS = 60_000

export interface VoiceStatus {
  /** VoiceStudio is running and will be used. */
  studio: boolean
  voices: StudioVoice[]
  /** Where it was looked for. */
  url: string
}

export class VoiceService {
  private client: { key: string; studio: VoiceStudio } | null = null
  private voiceList: { key: string; at: number; voices: StudioVoice[] } | null = null

  constructor(
    private readonly options: {
      settings: () => Promise<VoiceSettings>
      host: LibraryHost
      fetchImpl?: typeof fetch
    },
  ) {}

  private async studio(): Promise<{
    studio: VoiceStudio
    settings: VoiceSettings
    url: string
  } | null> {
    const settings = await this.options.settings()
    const url = settings.studioUrl || DEFAULT_STUDIO_URL
    if (!settings.enabled || !settings.useStudio) return null
    const key = `${url}|${settings.studioKey}`
    if (this.client?.key !== key) {
      this.client = {
        key,
        studio: new VoiceStudio({
          base: url,
          key: settings.studioKey || undefined,
          fetchImpl: this.options.fetchImpl,
        }),
      }
      this.voiceList = null
    }
    return { studio: this.client.studio, settings, url }
  }

  /** Whether VoiceStudio is there, and its voices. */
  async status(): Promise<VoiceStatus> {
    const s = await this.studio()
    const settings = await this.options.settings()
    const url = settings.studioUrl || DEFAULT_STUDIO_URL
    if (!s || !(await s.studio.available())) return { studio: false, voices: [], url }
    return { studio: true, voices: await this.voices(true).catch(() => []), url }
  }

  private async voices(fresh = false): Promise<StudioVoice[]> {
    const s = await this.studio()
    if (!s) return []
    const key = this.client!.key
    if (!fresh && this.voiceList?.key === key && Date.now() - this.voiceList.at < VOICES_FOR_MS) {
      return this.voiceList.voices
    }
    const voices = await s.studio.voices()
    this.voiceList = { key, at: Date.now(), voices }
    return voices
  }

  /** Speech for a passage in a voice (by its name in VoiceStudio; '' = its default), as WAV. */
  async speak(input: { text: string; voice: string }): Promise<Uint8Array> {
    const s = await this.studio()
    if (!s) throw new AppError('invalid-input', 'VoiceStudio isn’t in use (Settings → Voice).')
    let voiceId: string | null = null
    if (input.voice) {
      const find = (list: StudioVoice[]) => list.find((v) => v.name === input.voice)
      voiceId = (find(await this.voices()) ?? find(await this.voices(true)))?.id ?? null
    }
    const steps = STEPS[s.settings.quality]
    const speed = s.settings.rate
    const dir = join(this.options.host.current.paths.localDir, 'voice-cache')
    const file = join(dir, `${sha256(`${s.url}|${voiceId}|${speed}|${steps}|${input.text}`)}.wav`)
    try {
      return new Uint8Array(await fs.promises.readFile(file))
    } catch {
      // Not made yet.
    }
    const audio = await s.studio.speak({ text: input.text, voiceId, speed, steps })
    await fs.promises.mkdir(dir, { recursive: true })
    await writeFileAtomic(file, audio).catch(() => {})
    return audio
  }

  /** What was said, tidied (quote marks, the world's names). */
  async transcribe(audio: Uint8Array, mime: string, names: string[]): Promise<string> {
    const s = await this.studio()
    if (!s) throw new AppError('invalid-input', 'VoiceStudio isn’t in use (Settings → Voice).')
    const text = await s.studio.transcribe(
      audio,
      mime,
      names.length ? names.slice(0, 80).join(', ') : undefined,
    )
    return cleanDictation(text, names)
  }
}
