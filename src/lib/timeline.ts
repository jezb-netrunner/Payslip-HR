// Attendance timeline geometry: where each stretch of a work day falls on a
// Manila clock axis. Minutes count from the work date's Manila midnight, so a
// shift past midnight continues beyond 1440 instead of wrapping.
//
// Late, overtime and hours come from payroll's own computeAttendance for the
// day, so the bar never shows lateness or overtime that payroll won't count.

import { computeAttendance } from '../payroll/attendance'
import { shiftSpan, toResolver } from '../payroll/schedule'
import type { HolidayLite, ScheduleSource } from '../payroll/types'
import { hhmmToMinutes, manilaInstant } from './manila'

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
  /** worked minutes as payroll counts them (net of the unpaid break; open entries excluded) */
  workedMinutes: number
  /** overtime minutes as payroll counts them */
  otMinutes: number
  /** tardiness payroll charges for the day */
  lateMinutes: number
  late: boolean
}

export interface EntrySpan {
  clock_in: string
  clock_out: string | null
}

export interface DayTimelineOptions {
  /** draw an entry still open today up to this instant */
  now?: string
  graceMinutes?: number
  standardHoursPerDay?: number
  /** the client's holidays: payroll charges no tardiness on non-working ones */
  holidays?: HolidayLite[]
}

export function minutesFrom(date: string, iso: string): number {
  return (Date.parse(iso) - manilaInstant(date, 0).getTime()) / 60000
}

/** The scheduled shift on a date as [start, end] minutes (overnight past 1440), or null on a rest day. */
export function shiftOn(date: string, schedule: ScheduleSource | null | undefined): [number, number] | null {
  const shift = schedule ? toResolver(schedule)(date).shift : null
  if (!shift) return null
  const s = hhmmToMinutes(shift.start)
  return [s, s + shiftSpan(shift)]
}

/**
 * Splits a day's entries into drawable segments: time worked, its overtime
 * tail (the last minutes of the day, as payroll attributes it), gaps between
 * entries as breaks, and a late stretch ending at the first time in. An entry
 * without a time out is drawn up to `now` on its own day (marked live) and
 * counts for nothing, as in payroll.
 */
export function dayTimeline(
  date: string,
  entries: EntrySpan[],
  schedule: ScheduleSource | null | undefined,
  { now: nowIso, graceMinutes = 0, standardHoursPerDay = 8, holidays = [] }: DayTimelineOptions = {},
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

  const day = schedule
    ? computeAttendance({
        periodStart: date,
        periodEnd: date,
        schedule,
        standardHoursPerDay,
        gracePeriodMinutes: graceMinutes,
        entries: entries
          .filter((e) => e.clock_out)
          .map((e) => ({ work_date: date, clock_in: e.clock_in, clock_out: e.clock_out })),
        holidays,
        approvedLeaves: [],
      })[0]
    : undefined
  const lateMinutes = day?.lateMinutes ?? 0
  const otMinutes = day?.otMinutes ?? 0

  const segments: Segment[] = []
  const firstIn = spans.length ? spans[0].a : null
  if (lateMinutes > 0 && firstIn !== null) segments.push({ kind: 'late', from: firstIn - lateMinutes, to: firstIn })

  // overtime is the chronological tail of the day's closed entries
  const otFrom = new Map<number, number>()
  let otLeft = otMinutes
  for (let i = spans.length - 1; i >= 0 && otLeft > 0; i--) {
    const sp = spans[i]
    if (sp.open || sp.b <= sp.a) continue
    const take = Math.min(sp.b - sp.a, otLeft)
    otFrom.set(i, sp.b - take)
    otLeft -= take
  }

  let prevEnd: number | null = null
  spans.forEach((sp, i) => {
    if (sp.b <= sp.a) return // a time in without a time out (not today): nothing to draw, no break after it
    if (prevEnd !== null && sp.a > prevEnd) segments.push({ kind: 'break', from: prevEnd, to: sp.a })
    const mark = sp.live ? { live: true } : {}
    const cut = otFrom.get(i)
    if (cut !== undefined) {
      if (cut > sp.a) segments.push({ kind: 'work', from: sp.a, to: cut, ...mark })
      segments.push({ kind: 'overtime', from: cut, to: sp.b, ...mark })
    } else {
      segments.push({ kind: 'work', from: sp.a, to: sp.b, ...mark })
    }
    prevEnd = prevEnd === null ? sp.b : Math.max(prevEnd, sp.b)
  })

  const closed = spans.filter((s) => !s.open)
  return {
    date,
    segments,
    firstIn,
    lastOut: closed.length ? Math.max(...closed.map((s) => s.b)) : null,
    open: spans.some((s) => s.open),
    workedMinutes: day ? day.workedMinutes : closed.reduce((sum, s) => sum + (s.b - s.a), 0),
    otMinutes,
    lateMinutes,
    late: lateMinutes > 0,
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

/**
 * Axis ticks: every 2 hours (4 past a 24-hour span), always ending on the
 * window's end so the last label sits at the end of the bar.
 */
export function timelineTicks(lo: number, hi: number): number[] {
  const step = hi - lo > 1440 ? 240 : 120
  const ticks: number[] = []
  for (let m = lo; m < hi; m += step) ticks.push(m)
  if (hi - ticks[ticks.length - 1] < step / 2) ticks.pop()
  ticks.push(hi)
  return ticks
}
