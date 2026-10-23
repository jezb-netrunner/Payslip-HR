// Attendance timeline geometry: where each stretch of a work day falls on a
// Manila clock axis. Minutes count from the work date's Manila midnight, so a
// shift past midnight continues beyond 1440 instead of wrapping.

import type { WorkSchedule } from '../payroll/types'
import { hhmmToMinutes, isoWeekday, manilaInstant } from './manila'

export type SegmentKind = 'work' | 'break' | 'late' | 'overtime'

export interface Segment {
  kind: SegmentKind
  from: number
  to: number
  /** drawn up to now: an entry still open today */
  live?: boolean
}

export interface DayTimeline {
  date: string
  segments: Segment[]
  firstIn: number | null
  lastOut: number | null
  /** an entry without a time out */
  open: boolean
  workedMinutes: number
  /** first time in after the scheduled start (plus grace) on a scheduled day */
  late: boolean
}

export interface EntrySpan {
  clock_in: string
  clock_out: string | null
}

export function minutesFrom(date: string, iso: string): number {
  return (Date.parse(iso) - manilaInstant(date, 0).getTime()) / 60000
}

/** The scheduled shift on a date as [start, end] minutes, or null on a rest day. */
export function shiftOn(date: string, schedule: WorkSchedule | null | undefined): [number, number] | null {
  if (!schedule || !schedule.days.includes(isoWeekday(date))) return null
  const s = hhmmToMinutes(schedule.start)
  let e = hhmmToMinutes(schedule.end)
  if (e <= s) e += 1440 // overnight shift
  return [s, e]
}

/**
 * Splits a day's entries into drawable segments: time worked inside the
 * shift, overtime past the shift end, gaps between entries as breaks, and
 * the stretch from the shift start to a late first time in — late as payroll
 * counts it: after the shift start plus the client's grace period. With
 * `now`, an entry without a time out is drawn up to now (marked live) but not
 * counted as worked.
 */
export function dayTimeline(
  date: string,
  entries: EntrySpan[],
  schedule: WorkSchedule | null | undefined,
  { now: nowIso, graceMinutes = 0 }: { now?: string; graceMinutes?: number } = {},
): DayTimeline {
  const now = nowIso ? minutesFrom(date, nowIso) : null
  const spans = entries
    .map((e) => {
      const a = minutesFrom(date, e.clock_in)
      const live = !e.clock_out && now !== null && now > a && now - a < 1440
      const b = e.clock_out ? Math.max(a, minutesFrom(date, e.clock_out)) : live && now !== null ? now : a
      return { a, b, open: !e.clock_out, live }
    })
    .sort((x, y) => x.a - y.a)
  const shift = shiftOn(date, schedule)
  const segments: Segment[] = []
  const firstIn = spans.length ? spans[0].a : null
  const late = shift !== null && firstIn !== null && firstIn > shift[0] + graceMinutes
  if (late && shift && firstIn !== null) segments.push({ kind: 'late', from: shift[0], to: Math.min(firstIn, shift[1]) })

  let prevEnd: number | null = null
  for (const { a, b, live } of spans) {
    if (prevEnd !== null && a > prevEnd) segments.push({ kind: 'break', from: prevEnd, to: a })
    if (b > a) {
      const mark = live ? { live: true } : {}
      if (shift && b > shift[1]) {
        if (a < shift[1]) segments.push({ kind: 'work', from: a, to: shift[1], ...mark })
        segments.push({ kind: 'overtime', from: Math.max(a, shift[1]), to: b, ...mark })
      } else {
        segments.push({ kind: 'work', from: a, to: b, ...mark })
      }
    }
    prevEnd = prevEnd === null ? b : Math.max(prevEnd, b)
  }

  return {
    date,
    segments,
    firstIn,
    lastOut: spans.some((s) => !s.open) ? Math.max(...spans.filter((s) => !s.open).map((s) => s.b)) : null,
    open: spans.some((s) => s.open),
    workedMinutes: spans.filter((s) => !s.open).reduce((sum, s) => sum + (s.b - s.a), 0),
    late,
  }
}

/** A shared axis for several days: at least 06:00–24:00, widened in 2-hour steps to fit. */
export function timelineWindow(days: DayTimeline[], shifts: ([number, number] | null)[] = []): [number, number] {
  let lo = 360
  let hi = 1440
  for (const d of days) {
    for (const s of d.segments) {
      lo = Math.min(lo, s.from)
      hi = Math.max(hi, s.to)
    }
    if (d.firstIn !== null) lo = Math.min(lo, d.firstIn)
  }
  for (const s of shifts) {
    if (!s) continue
    lo = Math.min(lo, s[0])
    hi = Math.max(hi, s[1])
  }
  return [Math.max(-720, Math.floor(lo / 120) * 120), Math.min(2160, Math.ceil(hi / 120) * 120)]
}
