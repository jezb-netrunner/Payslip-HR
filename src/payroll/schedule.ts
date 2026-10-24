// Work schedules resolved per date (pure; the database rows are loaded by
// src/lib/schedules.ts). For a date, a roster change for that date wins,
// then the newest weekly pattern in force — patterns are effective-dated, so
// an earlier period always computes with the schedule it had — then the
// employee's base schedule (employees.work_schedule).

import { hhmmToMinutes, isoWeekday } from '../lib/manila'
import type { ScheduleResolver, ScheduleSource, Shift, WeekPattern, WorkSchedule } from './types'

/** An employee's weekly pattern from a date on (employee_schedules). */
export interface ScheduleVersion {
  employee_id: string
  effective_from: string
  pattern: WeekPattern
}

/** A roster change for one date (schedule_overrides); shift null = rest day. */
export interface ScheduleOverride {
  employee_id: string
  work_date: string
  shift: Shift | null
}

/** Minutes from start to end; an end at or before the start is the next day. */
export function shiftSpan(s: Pick<Shift, 'start' | 'end'>): number {
  const a = hhmmToMinutes(s.start)
  const b = hhmmToMinutes(s.end)
  return b > a ? b - a : b - a + 1440
}

/**
 * The unpaid part of a meal break: a meal period is at least an hour, and a
 * shorter one counts as paid time (Labor Code Art. 85; IRR Book III Rule I
 * Sec. 7), so only a break of 60 minutes or more comes off the day.
 */
export function unpaidBreak(breakMinutes: number): number {
  return breakMinutes >= 60 ? breakMinutes : 0
}

/** Work minutes a shift schedules: its span less the unpaid break. */
export function shiftWorkMinutes(s: Shift): number {
  return Math.max(0, shiftSpan(s) - unpaidBreak(s.break_minutes))
}

/** A compressed-workweek day may run 12 hours at most (DOLE Department Advisory 02-04). */
export const MAX_COMPRESSED_MINUTES = 720

export function patternFromWorkSchedule(ws: WorkSchedule): WeekPattern {
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    ws.days.includes(d) ? { start: ws.start, end: ws.end, break_minutes: ws.break_minutes } : null,
  )
}

/** The break for a day worked without a shift (rest-day work): the pattern's first shift's, else an hour. */
export function restDayBreak(p: WeekPattern): number {
  return p.find((s) => s)?.break_minutes ?? 60
}

/** The weekly pattern in force on a date: the newest one that started by then, else the base. */
export function patternOn(base: WeekPattern, versions: Pick<ScheduleVersion, 'effective_from' | 'pattern'>[], date: string): WeekPattern {
  let best: Pick<ScheduleVersion, 'effective_from' | 'pattern'> | null = null
  for (const v of versions) {
    if (v.effective_from <= date && (!best || v.effective_from > best.effective_from)) best = v
  }
  return best ? best.pattern : base
}

/** One employee's schedule per date, from their base schedule, patterns and roster changes. */
export function makeResolver(
  base: WorkSchedule,
  versions: Pick<ScheduleVersion, 'effective_from' | 'pattern'>[] = [],
  overrides: Pick<ScheduleOverride, 'work_date' | 'shift'>[] = [],
): ScheduleResolver {
  const basePattern = patternFromWorkSchedule(base)
  const byDate = new Map(overrides.map((o) => [o.work_date, o.shift ?? null]))
  return (date) => {
    const pattern = patternOn(basePattern, versions, date)
    const restDayBreakMinutes = restDayBreak(pattern)
    if (byDate.has(date)) return { shift: byDate.get(date) ?? null, restDayBreakMinutes }
    return { shift: pattern[isoWeekday(date) - 1] ?? null, restDayBreakMinutes }
  }
}

export function toResolver(s: ScheduleSource): ScheduleResolver {
  return typeof s === 'function' ? s : makeResolver(s)
}

export function sameShift(a: Shift | null | undefined, b: Shift | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.break_minutes === b.break_minutes &&
    (a.flex_minutes ?? 0) === (b.flex_minutes ?? 0) &&
    !!a.compressed === !!b.compressed
  )
}
