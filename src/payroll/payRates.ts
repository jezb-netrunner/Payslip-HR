// Pay-rate history: the rate in effect on a date, the rates over a pay
// period, and each change against the rate before it.
import { round2, type RateSegment } from './types'

export type PayRateReason = 'hired' | 'regularized' | 'merit_increase' | 'promotion' | 'wage_order' | 'adjustment' | 'correction'

export interface PayRateRow {
  effective_from: string
  pay_type: 'monthly' | 'daily'
  rate: number | string
}

const byDate = <T extends PayRateRow>(rows: T[]): T[] => [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from))

/** The rate in effect on `date`: the latest change on or before it, else the first one (the rate before the history began). */
export function rateOn<T extends PayRateRow>(rows: T[], date: string): T | undefined {
  const sorted = byDate(rows)
  let found: T | undefined
  for (const r of sorted) {
    if (r.effective_from > date) break
    found = r
  }
  return found ?? sorted[0]
}

const segmentOf = (from: string, r: PayRateRow): RateSegment => ({
  from,
  payType: r.pay_type,
  monthlyRate: r.pay_type === 'monthly' ? Number(r.rate) : 0,
  dailyRate: r.pay_type === 'daily' ? Number(r.rate) : 0,
})

/** The rates over a pay period: the one in effect on its first day, then each change inside it ([] without a history). */
export function rateSegments(rows: PayRateRow[], start: string, end: string): RateSegment[] {
  const first = rateOn(rows, start)
  if (!first) return []
  const out = [segmentOf(start, first)]
  for (const r of byDate(rows)) {
    if (r.effective_from <= start || r.effective_from > end) continue
    const s = segmentOf(r.effective_from, r)
    const last = out[out.length - 1]
    // a change to the same rate (a correction of the note) splits nothing
    if (last.payType === s.payType && last.monthlyRate === s.monthlyRate && last.dailyRate === s.dailyRate) continue
    out.push(s)
  }
  return out
}

/** A rate as a monthly amount: a daily rate × the days-per-year factor ÷ 12 (the statutory base). */
export function monthlyEquivalent(r: PayRateRow, daysPerYear: number): number {
  return r.pay_type === 'monthly' ? Number(r.rate) : round2((Number(r.rate) * daysPerYear) / 12)
}

export interface RateChange<T extends PayRateRow> {
  row: T
  previous?: T
  /** ₱ change from the previous rate: in its own basis, or monthly amounts when the basis changed. */
  change?: number
  /** % change from the previous rate. */
  pct?: number
}

/** Each rate, oldest first, with its change from the rate before it. */
export function rateChanges<T extends PayRateRow>(rows: T[], daysPerYear: number): RateChange<T>[] {
  const sorted = byDate(rows)
  return sorted.map((row, i) => {
    const previous = sorted[i - 1]
    if (!previous) return { row }
    const same = previous.pay_type === row.pay_type
    const from = same ? Number(previous.rate) : monthlyEquivalent(previous, daysPerYear)
    const to = same ? Number(row.rate) : monthlyEquivalent(row, daysPerYear)
    return { row, previous, change: round2(to - from), pct: from > 0 ? round2(((to - from) / from) * 100) : undefined }
  })
}

export interface PayChange<T extends PayRateRow> extends RateChange<T> {
  previous: T
  /** Change in the monthly amount (a daily rate × days-per-year ÷ 12), for cost totals. */
  monthlyChange: number
}

/**
 * The changes of an employee's rate that took effect from `from` to `to`
 * (inclusive): not the hire rate, not a correction of an earlier entry.
 */
export function changesBetween<T extends PayRateRow & { reason: PayRateReason }>(
  rows: T[],
  from: string,
  to: string,
  daysPerYear: number,
): PayChange<T>[] {
  return rateChanges(rows, daysPerYear).flatMap((c) =>
    c.previous && c.row.effective_from >= from && c.row.effective_from <= to && c.row.reason !== 'hired' && c.row.reason !== 'correction'
      ? [{ ...c, previous: c.previous, monthlyChange: round2(monthlyEquivalent(c.row, daysPerYear) - monthlyEquivalent(c.previous, daysPerYear)) }]
      : [],
  )
}
