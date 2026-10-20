// Helpers for Asia/Manila civil time (UTC+8, no DST).
// All attendance math is done in Manila local time regardless of the
// viewer's browser timezone.

export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

export interface ManilaParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number
  minute: number
  second: number
}

/** Convert an absolute instant to Manila wall-clock parts. */
export function toManilaParts(d: Date): ManilaParts {
  const shifted = new Date(d.getTime() + MANILA_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** ISO date (YYYY-MM-DD) of an instant, in Manila. */
export function manilaDateStr(d: Date): string {
  const p = toManilaParts(d)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Minutes since Manila midnight for an instant. */
export function manilaMinutesOfDay(d: Date): number {
  const p = toManilaParts(d)
  return p.hour * 60 + p.minute + p.second / 60
}

/** Absolute instant for a Manila wall-clock date + minutes-of-day. */
export function manilaInstant(dateStr: string, minutesOfDay: number): Date {
  const [y, m, day] = dateStr.split('-').map(Number)
  const utcMidnight = Date.UTC(y, m - 1, day, 0, 0, 0)
  return new Date(utcMidnight - MANILA_OFFSET_MS + minutesOfDay * 60 * 1000)
}

/** Day of week (1=Mon .. 7=Sun) for a YYYY-MM-DD string. */
export function isoWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun
  return wd === 0 ? 7 : wd
}

/** Enumerate YYYY-MM-DD strings from start to end inclusive. */
export function eachDate(startStr: string, endStr: string): string[] {
  const out: string[] = []
  const [ys, ms, ds] = startStr.split('-').map(Number)
  const [ye, me, de] = endStr.split('-').map(Number)
  const cur = new Date(Date.UTC(ys, ms - 1, ds))
  const end = new Date(Date.UTC(ye, me - 1, de))
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

/** "HH:MM" -> minutes since midnight */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function todayManila(): string {
  return manilaDateStr(new Date())
}

/** "HH:MM" Manila wall time of an instant. */
export function manilaHHMM(iso: string): string {
  const p = toManilaParts(new Date(iso))
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/**
 * ISO instant for a Manila work date + "HH:MM" wall time, optionally on the
 * following calendar day (the end of an overnight shift).
 */
export function manilaWallToIso(dateStr: string, hhmm: string, nextDay = false): string {
  return manilaInstant(dateStr, hhmmToMinutes(hhmm) + (nextDay ? 1440 : 0)).toISOString()
}

/** YYYY-MM-DD plus n days (calendar arithmetic, timezone-free). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Last calendar day of the month of a YYYY-MM-DD date. */
export function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
