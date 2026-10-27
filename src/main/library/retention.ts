/**
 * Which version-history snapshots to keep:
 * - everything from the last 2 weeks;
 * - then the newest snapshot of each day, up to 3 months;
 * - then the newest snapshot of each week.
 * The newest snapshot overall is always kept.
 */
const DAY = 24 * 60 * 60 * 1000
export const KEEP_ALL_DAYS = 14
export const KEEP_DAILY_DAYS = 90

/** Returns the indexes (into `times`) of the snapshots to keep. */
export function snapshotsToKeep(times: Date[], now: Date): Set<number> {
  const keep = new Set<number>()
  const newestPerBucket = new Map<string, number>()
  let newest = -1

  times.forEach((time, i) => {
    if (newest < 0 || time > times[newest]!) newest = i
    const age = now.getTime() - time.getTime()
    if (age <= KEEP_ALL_DAYS * DAY) {
      keep.add(i)
      return
    }
    const bucket = age <= KEEP_DAILY_DAYS * DAY ? `day:${dayKey(time)}` : `week:${weekKey(time)}`
    const current = newestPerBucket.get(bucket)
    if (current === undefined || time > times[current]!) newestPerBucket.set(bucket, i)
  })

  for (const i of newestPerBucket.values()) keep.add(i)
  if (newest >= 0) keep.add(newest)
  return keep
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** ISO week, e.g. 2026-W44 (weeks start on Monday). */
function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const weekday = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7)
  return `${d.getUTCFullYear()}-W${week}`
}
