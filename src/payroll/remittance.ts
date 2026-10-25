// What each month's BIR Form 1601-C remits (spec T8): the tax withheld from
// pay released in the month, plus tax the employer paid for employees at a
// year-end adjustment, less year-end refunds paid in the month. A refund the
// month's remittance can't absorb is recovered from the following months,
// across the year end.

import { round2 } from './types'

export interface RemittanceMonth {
  /** YYYY-MM-01 of the pay date. */
  month: string
  /** Tax withheld (positive withholding on the month's payslips). */
  withheld: number
  /** Tax the employer paid at a year-end adjustment the pay couldn't cover. */
  employerPaid: number
  /** Year-end refunds paid to employees in the month. */
  refunds: number
}

export interface RemittanceRow extends RemittanceMonth {
  /** Refunds of earlier months not yet recovered. */
  carriedIn: number
  /** Refunds recovered from this month's remittance. */
  recovered: number
  /** What the month's 1601-C remits: withheld + employer-paid − recovered. */
  due: number
  /** Refunds still to recover from later months. */
  carryOut: number
}

/** A payslip's tax figures, as read from the database (numeric columns may arrive as strings). */
export interface RemittanceSlip {
  pay_date: string | null
  withholding_tax: number | string
  tax_paid_by_employer?: number | string | null
}

// Basis: RR 2-98 §2.79(B)(5)(b), as amended by RR 11-2018 §7: refunds are due "not later than January 25" of the following year.
/** The year-end refund deadline for a tax year. */
export function refundDeadline(taxYear: number): string {
  return `${taxYear + 1}-01-25`
}

/** Payslips by the month their pay was released, oldest first. */
export function remittanceMonths(slips: readonly RemittanceSlip[]): RemittanceMonth[] {
  const by = new Map<string, RemittanceMonth>()
  for (const s of slips) {
    if (!s.pay_date) continue
    const month = `${s.pay_date.slice(0, 7)}-01`
    const m = by.get(month) ?? { month, withheld: 0, employerPaid: 0, refunds: 0 }
    const wht = Number(s.withholding_tax) || 0
    if (wht < 0) m.refunds += -wht
    else m.withheld += wht
    m.employerPaid += Number(s.tax_paid_by_employer ?? 0) || 0
    by.set(month, m)
  }
  return [...by.values()]
    .map((m) => ({ ...m, withheld: round2(m.withheld), employerPaid: round2(m.employerPaid), refunds: round2(m.refunds) }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

// Basis: RR 2-98 §2.79(B)(5)(b) Steps 1–4, as amended by RR 11-2018 §7 (refunds by January 25, recovered from the employer's later remittances, tax the employer pays when it can't be withheld). RR 2-98 §2.83.1, as amended by RR 11-2018 §12.
/**
 * The 1601-C schedule, one row per month from the earliest month (or
 * `span.from`) through the latest (or `span.through`), months without
 * payroll included: refunds are recovered from the month they were paid in
 * first, then from each following month until recovered in full.
 */
export function remittanceSchedule(
  months: readonly RemittanceMonth[],
  carriedIn = 0,
  span: { from?: string; through?: string } = {},
): RemittanceRow[] {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month))
  const from = span.from ?? sorted[0]?.month
  const through = span.through ?? sorted[sorted.length - 1]?.month
  if (!from || !through) return []
  const rows: RemittanceRow[] = []
  let carry = round2(carriedIn)
  for (let month = from; month <= through; month = nextMonth(month)) {
    const m = sorted.find((x) => x.month === month) ?? { month, withheld: 0, employerPaid: 0, refunds: 0 }
    const toRemit = round2(m.withheld + m.employerPaid)
    const toRecover = round2(carry + m.refunds)
    const recovered = Math.min(toRemit, toRecover)
    rows.push({
      ...m,
      carriedIn: carry,
      recovered,
      due: round2(toRemit - recovered),
      carryOut: round2(toRecover - recovered),
    })
    carry = round2(toRecover - recovered)
  }
  return rows
}

/**
 * One tax year's twelve 1601-C months from the payslips paid in it and the
 * year before: refunds last year's remittances couldn't absorb carry in.
 */
export function yearRemittanceSchedule(slips: readonly RemittanceSlip[], year: number): RemittanceRow[] {
  const inYear = (y: number) => slips.filter((s) => s.pay_date?.startsWith(`${y}-`))
  const last = remittanceSchedule(remittanceMonths(inYear(year - 1)), 0, { from: `${year - 1}-01-01`, through: `${year - 1}-12-01` })
  const carriedIn = last[last.length - 1]?.carryOut ?? 0
  return remittanceSchedule(remittanceMonths(inYear(year)), carriedIn, { from: `${year}-01-01`, through: `${year}-12-01` })
}
