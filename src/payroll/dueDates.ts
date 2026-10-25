// Filing and remittance due dates (spec T9). Dates are computed, never moved
// for weekends or holidays (spec P8): a Saturday or Sunday is marked, and
// the user overrides a date, with a note, when the BIR extends a deadline
// (it does so by RMC, e.g. RMC 12, 62, 89 and 95-2026). SSS, PhilHealth and
// Pag-IBIG schedules are pending (P6): a client setting with no default.

import { endOfMonth, isoWeekday } from '../lib/manila'
import { refundDeadline } from './remittance'

export type FilingMode = 'manual_or_ebirforms' | 'efps'
export type EfpsGroup = 'A' | 'B' | 'C' | 'D' | 'E'
export type ObligationKey = '1601c' | 'sss' | 'philhealth' | 'pagibig' | 'yea_refund' | '2316_employees' | '1604c' | '2316_duplicates'
export type ContributionKey = 'sss' | 'philhealth' | 'pagibig'

/** eFPS filers file on day N of the next month by their filing group. */
export const EFPS_GROUP_DAY: Record<EfpsGroup, number> = { A: 15, B: 14, C: 13, D: 12, E: 11 }

/** YYYY-MM-01 of the month after `month`. */
function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/** Day `day` of the month of `month` (YYYY-MM-01), at most its last day. */
function dayOf(month: string, day: number): string {
  const last = Number(endOfMonth(month).slice(8, 10))
  return `${month.slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`
}

// Basis: BIR Form 1601-C (January 2018 ENCS), guidelines. RR 26-2002 §2 (Dec 19, 2002), which RMC 125-2020 (Nov 26, 2020) applies to the 1601-C.
/**
 * The 1601-C of a withholding month (YYYY-MM-01): January to November, the
 * 10th of the next month (manual or eBIRForms) or day N of the next month
 * by eFPS group; December, January 15 (manual) or day N of January (eFPS).
 * Null for an eFPS filer whose group isn't set.
 */
export function due1601c(month: string, mode: FilingMode, group?: EfpsGroup | null): string | null {
  const next = nextMonth(month)
  if (mode === 'efps') return group ? dayOf(next, EFPS_GROUP_DAY[group]) : null
  return dayOf(next, month.slice(5, 7) === '12' ? 15 : 10)
}

// Basis: RR 11-2018 §§7, 12. RMC 55-2026 (May 26, 2026). RR 16-2021 §2 (scanned 2316 copies).
/**
 * The dates of a tax year: year-end refunds by January 25, the 2316 to
 * employees by January 31 (at final pay for employees who leave), the
 * 1604-C with the alphalist by January 31, and the scanned 2316 duplicates
 * with the certified list by February 28 — all of the next year.
 */
export function annualDueDates(taxYear: number): { key: ObligationKey; date: string }[] {
  const next = taxYear + 1
  return [
    { key: 'yea_refund', date: refundDeadline(taxYear) },
    { key: '2316_employees', date: `${next}-01-31` },
    { key: '1604c', date: `${next}-01-31` },
    { key: '2316_duplicates', date: `${next}-02-28` },
  ]
}

/** A contribution month's remittance: day `day` of the next month (at most its last day). */
export function contributionDue(month: string, day: number): string {
  return dayOf(nextMonth(month), day)
}

/** Saturday or Sunday. */
export function isWeekend(date: string): boolean {
  return isoWeekday(date) >= 6
}

export interface DueDateOverride {
  obligation: ObligationKey
  /** YYYY-MM-01 of the month covered; January 1 of the tax year for the annual dates. */
  period: string
  due_date: string
  note: string
}

export interface DueItem {
  key: ObligationKey
  period: string
  /** The computed date; null when the client's settings don't give one. */
  computed: string | null
  /** The date in force: the override, else the computed date. */
  date: string | null
  weekend: boolean
  overridden: boolean
  note: string
}

/**
 * A year's calendar: the 1601-C and contribution remittances of each month
 * of `year`, then the annual dates of tax year `year`, with the client's
 * overrides applied.
 */
export function dueCalendar(params: {
  year: number
  filing: { mode: FilingMode | null; group: EfpsGroup | null }
  contributionDays: Record<ContributionKey, number | null>
  overrides: readonly DueDateOverride[]
}): DueItem[] {
  const { year, filing, contributionDays, overrides } = params
  const item = (key: ObligationKey, period: string, computed: string | null): DueItem => {
    const o = overrides.find((x) => x.obligation === key && x.period === period)
    const date = o?.due_date ?? computed
    return { key, period, computed, date, weekend: !!date && isWeekend(date), overridden: !!o, note: o?.note ?? '' }
  }
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}-01`)
  const items: DueItem[] = []
  for (const month of months) {
    items.push(item('1601c', month, filing.mode ? due1601c(month, filing.mode, filing.group) : null))
    for (const key of ['sss', 'philhealth', 'pagibig'] as const) {
      const day = contributionDays[key]
      if (day) items.push(item(key, month, contributionDue(month, day)))
    }
  }
  for (const a of annualDueDates(year)) items.push(item(a.key, `${year}-01-01`, a.date))
  return items
}
