import { describe, expect, it } from 'vitest'
import type { AiJobInfo } from '@shared/ipc'
import { AppError } from '../errors'
import { AiJobs } from './jobs'

const info = (id: string) => ({
  id,
  kind: 'ask' as const,
  seriesId: 'ser_aaaaaaaaaaaaaaaa',
  conversation: null,
  volumeId: null,
  chapterId: null,
  chapterTitle: '',
  sent: null,
  origin: 1,
})

describe('AI work in the background', () => {
  it('keeps what streamed and the result, lists it until a pane takes it', async () => {
    const events: string[] = []
    const changed: AiJobInfo['state'][] = []
    const jobs = new AiJobs({
      token: (_id, t) => events.push(`token:${t}`),
      progress: (_id, t) => events.push(`progress:${t}`),
      changed: (j) => changed.push(j.state),
    })
    let release!: () => void
    const done = jobs.run(info('a'), async (onToken, onProgress) => {
      onProgress('Reading…')
      onToken('Hel')
      onToken('lo')
      await new Promise<void>((r) => (release = r))
      return { text: 'Hello' }
    })
    await Promise.resolve()
    // While running, a pane opened now sees what came so far.
    expect(jobs.list('ser_aaaaaaaaaaaaaaaa')).toMatchObject([{ state: 'running', text: 'Hello' }])
    release()
    expect(await done).toEqual({ text: 'Hello' })
    expect(jobs.list('ser_aaaaaaaaaaaaaaaa')).toMatchObject([{ state: 'done', text: 'Hello' }])
    expect(events).toEqual(['progress:Reading…', 'token:Hel', 'token:lo'])
    expect(changed).toEqual(['running', 'done'])
    jobs.seen('a')
    expect(jobs.list('ser_aaaaaaaaaaaaaaaa')).toEqual([])
  })

  it('records failures and stops, and runs the finishing step either way', async () => {
    const jobs = new AiJobs({ token: () => {}, progress: () => {}, changed: () => {} })
    const finished: string[] = []
    await expect(
      jobs.run(
        info('b'),
        async (onToken) => {
          onToken('part')
          throw new AppError('cancelled', 'Stopped.')
        },
        async (job) => void finished.push(`${job.state}:${job.text}`),
      ),
    ).rejects.toThrow('Stopped.')
    await expect(
      jobs.run(info('c'), async () => {
        throw new Error('down')
      }),
    ).rejects.toThrow('down')
    expect(finished).toEqual(['cancelled:part'])
    expect(jobs.list('ser_aaaaaaaaaaaaaaaa').map((j) => [j.id, j.state, j.error])).toEqual([
      ['b', 'cancelled', 'Stopped.'],
      ['c', 'failed', 'down'],
    ])
  })
})
