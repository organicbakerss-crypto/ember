import { describe, expect, it } from 'vitest'
import { snapshotsToKeep } from './retention'

const now = new Date('2026-10-27T12:00:00Z')
const daysAgo = (d: number, hours = 0) => new Date(now.getTime() - (d * 24 + hours) * 3600_000)

describe('snapshot retention', () => {
  it('keeps everything from the last two weeks', () => {
    const times = Array.from({ length: 50 }, (_, i) => daysAgo(i % 14, i % 5))
    expect(snapshotsToKeep(times, now).size).toBe(50)
  })

  it('keeps the newest snapshot of each day between two weeks and three months', () => {
    const times = [daysAgo(20, 1), daysAgo(20, 5), daysAgo(20, 9), daysAgo(21, 2)]
    const keep = snapshotsToKeep(times, now)
    expect([...keep].sort()).toEqual([0, 3])
  })

  it('keeps one snapshot per week after three months', () => {
    // Monday 2026-06-01 and Wednesday 2026-06-03 share an ISO week; Monday 2026-06-08 doesn't.
    const times = [
      new Date('2026-06-01T10:00:00Z'),
      new Date('2026-06-03T10:00:00Z'),
      new Date('2026-06-08T10:00:00Z'),
    ]
    const keep = snapshotsToKeep(times, now)
    expect([...keep].sort()).toEqual([1, 2])
  })

  it('always keeps the newest snapshot, however old', () => {
    const times = [new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z')]
    expect(snapshotsToKeep(times, now).has(1)).toBe(true)
  })

  it('handles no snapshots', () => {
    expect(snapshotsToKeep([], now).size).toBe(0)
  })
})
