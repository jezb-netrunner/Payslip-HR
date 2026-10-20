// Pay-period suggestions for new payroll runs. Continues a client's own
// cutoffs (e.g. semi-monthly 10th/25th, monthly 26th–25th) from its last
// regular runs; falls back to calendar periods for the first run.

import type { PayFrequency } from '../payroll/types'
import { addDays, endOfMonth, isoWeekday } from './manila'

function iso(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1, Math.min(d, last))).toISOString().slice(0, 10)
}

/** Same day next month (clamped), minus one day: the end of a monthly period. */
function monthlyEnd(start: string): string {
  const [y, m, d] = start.split('-').map(Number)
  return addDays(iso(y, m + 1, d), -1)
}

/** Semi-monthly cutoff of a period end: 31 stands for end of month. */
function cutoff(date: string): number {
  return date === endOfMonth(date) ? 31 : Number(date.slice(8, 10))
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
  if (frequency === 'monthly') return { start, end: monthlyEnd(start) }

  // semi-monthly: the next end is the other cutoff day seen in the last two runs
  const [y, m, d] = start.split('-').map(Number)
  const lastCut = cutoff(last.period_end)
  const otherCut = previous[1] ? cutoff(previous[1].period_end) : lastCut <= 15 ? 31 : 15
  const endIn = (yy: number, mm: number) => (otherCut >= 28 ? endOfMonth(iso(yy, mm, 1)) : iso(yy, mm, otherCut))
  return { start, end: otherCut > d ? endIn(y, m) : endIn(y, m + 1) }
}

/**
 * Payroll month and slot of a pay date: semi-monthly runs are payroll 1 or 2
 * of the month by pay day; weekly runs are the k-th of the 4–5 paydays that
 * fall on the same weekday in the month.
 */
export function slotFor(frequency: PayFrequency, payDate: string): { month: string; index: number; count: number } {
  const [y, m, d] = payDate.split('-').map(Number)
  const month = iso(y, m, 1)
  if (frequency === 'monthly') return { month, index: 1, count: 1 }
  if (frequency === 'semi_monthly') return { month, index: d <= 15 ? 1 : 2, count: 2 }
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const firstSameWeekday = ((d - 1) % 7) + 1
  return { month, index: Math.ceil(d / 7), count: Math.floor((daysInMonth - firstSameWeekday) / 7) + 1 }
}
