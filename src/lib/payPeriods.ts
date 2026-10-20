// Pay-period suggestions for new payroll runs. Continues a client's own
// cutoffs (e.g. semi-monthly 10th/25th, monthly 26th–25th) from its last
// regular runs; falls back to calendar periods for the first run.

import type { PayFrequency } from '../payroll/types'
import { addDays, endOfMonth, isoWeekday } from './manila'

function iso(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1, Math.min(d, last))).toISOString().slice(0, 10)
}

/**
 * A client's cutoff day from period ends one month apart (31 = end of
 * month). Any two consecutive months include a 31-day month, so the larger
 * of two samples recovers a 29th/30th cutoff that February or a 30-day
 * month clamped; a lone month-end sample is read as end of month.
 */
function cutoffDay(ends: (string | undefined)[]): number {
  const known = ends.filter((e): e is string => !!e)
  if (known.length === 1 && known[0] === endOfMonth(known[0])) return 31
  return Math.max(...known.map((e) => Number(e.slice(8, 10))))
}

/** First date on or after `start` that falls on the cutoff (clamped to month length). */
function nextCutoff(start: string, cut: number): string {
  const [y, m, d] = start.split('-').map(Number)
  const here = iso(y, m, cut)
  return Number(here.slice(8, 10)) >= d ? here : iso(y, m + 1, cut)
}

/**
 * Next pay period for a frequency. `previous` are the client's regular runs
 * of that frequency, most recent first.
 */
export function suggestPeriod(
  frequency: PayFrequency,
  previous: { period_end: string }[],
  today: string,
): { start: string; end: string } {
  const last = previous[0]
  if (!last) {
    const [y, m, d] = today.split('-').map(Number)
    if (frequency === 'weekly') {
      const start = addDays(today, 1 - isoWeekday(today)) // Monday
      return { start, end: addDays(start, 6) }
    }
    if (frequency === 'monthly') return { start: iso(y, m, 1), end: endOfMonth(today) }
    return d <= 15 ? { start: iso(y, m, 1), end: iso(y, m, 15) } : { start: iso(y, m, 16), end: endOfMonth(today) }
  }

  const start = addDays(last.period_end, 1)
  if (frequency === 'weekly') return { start, end: addDays(start, 6) }
  if (frequency === 'monthly') {
    return { start, end: nextCutoff(start, cutoffDay([last.period_end, previous[1]?.period_end])) }
  }
  // semi-monthly: the next end is the other cutoff, last seen one and two
  // months back (runs 2 and 4)
  const other = previous[1]
    ? cutoffDay([previous[1].period_end, previous[3]?.period_end])
    : Number(last.period_end.slice(8, 10)) <= 15
      ? 31
      : 15
  return { start, end: nextCutoff(start, other) }
}

/**
 * Payroll month and slot of a pay period, from its END (the cutoff):
 * semi-monthly periods ending on the 15th or earlier are payroll 1 of their
 * month, later ones payroll 2; weekly periods are the k-th of the 4–5 that
 * end on the same weekday in the month. Cutoffs don't move when a payday is
 * moved for a holiday, so every month keeps a complete set of slots.
 */
export function slotFor(frequency: PayFrequency, periodEnd: string): { month: string; index: number; count: number } {
  const [y, m, d] = periodEnd.split('-').map(Number)
  const month = iso(y, m, 1)
  if (frequency === 'monthly') return { month, index: 1, count: 1 }
  if (frequency === 'semi_monthly') return { month, index: d <= 15 ? 1 : 2, count: 2 }
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const firstSameWeekday = ((d - 1) % 7) + 1
  return { month, index: Math.ceil(d / 7), count: Math.floor((daysInMonth - firstSameWeekday) / 7) + 1 }
}
