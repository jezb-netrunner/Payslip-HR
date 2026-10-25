// Withholding method for one payroll (spec T2). The regular method finds the
// table row from regular compensation (R) only; the cumulative average
// method (CAM) takes over from a trigger to the end of the calendar year.
// Tax amounts are exact (whole centavos, rates to six decimals) and rounded
// to the centavo only at the end.

import { bracketFor, taxOnRow } from './statutory'
import { round2, type BirBucket, type PayFrequency, type TaxBracket, type WhtMethod } from './types'

/** One finalized payslip of this employer, earlier in the tax year (by pay date). */
export interface WithholdingYtdFact {
  payDate: string
  /** R: taxable regular compensation. */
  regular: number
  /** S: taxable supplementary compensation. */
  supplementary: number
  /** Tax withheld (negative for a refund). */
  withheld: number
  /** How it was withheld; undefined for a payslip from before this rule. */
  method?: WhtMethod
  /** Gross pay: more than 0 means compensation was paid. */
  gross: number
  /** A 13th-month payslip: it pays no regular compensation of its own. */
  supplementaryOnly?: boolean
}

/** Previous employers this calendar year (their BIR Form 2316). */
export interface PriorWithholding {
  /** Taxable compensation they paid. */
  taxable: number
  withheld: number
  /** First day of that employment (counting starts on January 1 at the earliest). */
  employedFrom?: string | null
}

/**
 * Why CAM applies: (a) R is in the 0% row and S was paid this year, (b) S is
 * at least R, (c) a previous employer this year, or a trigger in an earlier
 * payroll of the year.
 */
export type CamTrigger = 'a' | 'b' | 'c' | 'earlier'

export interface PeriodWithholdingInput {
  regular: number
  supplementary: number
  payDate: string
  frequency: PayFrequency
  /** The table for this payroll frequency. */
  brackets: TaxBracket[]
  ytd: readonly WithholdingYtdFact[]
  prior?: PriorWithholding | null
  /** A 13th-month payslip (see WithholdingYtdFact). */
  supplementaryOnly?: boolean
}

export interface PeriodWithholding {
  tax: number
  method: 'regular' | 'cam'
  trigger?: CamTrigger
  /** CAM: pay periods counted, from `from` to this payroll. */
  n?: number
  from?: string
  /** CAM: taxable compensation this year, previous employers included. */
  cum?: number
  totalDue?: number
  /** CAM: tax withheld this year before this payroll, previous employers included. */
  withheldBefore?: number
  /** Pay date of the earlier payroll that started CAM. */
  since?: string
}

const cents = (pesos: number) => BigInt(Math.round(pesos * 100))
const pesos = (c: bigint) => Number(c) / 100

// Basis: RR 2-98 §2.79(B)(3) Steps 3–4, as amended by RR 11-2018 §7.
/** Regular method: the row from R alone, applied to R + S. */
export function regularMethodTax(regular: number, supplementary: number, brackets: TaxBracket[]): number {
  if (regular + supplementary <= 0) return 0
  return taxOnRow(regular + supplementary, bracketFor(regular, brackets))
}

// Basis: RR 2-98 §2.79(B)(5)(a) Steps 1–5, as amended by RR 11-2018 §7.
/**
 * Tax due for the year to date under CAM: the table on the average cum / n,
 * times n. Computed as n × base + rate × (cum − n × lower bound) on the
 * average's row, so the average is never rounded.
 */
export function camTotalDue(cum: number, n: number, brackets: TaxBracket[]): number {
  if (cum <= 0 || n < 1) return 0
  const N = BigInt(n)
  const c = cents(cum)
  let row = brackets[0]
  for (const b of brackets) {
    if (cents(b.over) * N <= c) row = b
    else break
  }
  const rate = BigInt(Math.round(row.rate * 1_000_000))
  const scaled = cents(row.base) * N * 1_000_000n + rate * (c - cents(row.over) * N)
  return pesos((scaled + 500_000n) / 1_000_000n)
}

const ymd = (d: string) => d.split('-').map(Number)

/**
 * Pay periods of this frequency from the one holding `from` to the one
 * holding `to`, both included (semi-monthly halves end on the 15th). Our
 * reading of "the number of payroll period to which the amount relates".
 */
export function periodsBetween(frequency: PayFrequency, from: string, to: string): number {
  if (to < from) return 1
  const [y1, m1, d1] = ymd(from)
  const [y2, m2, d2] = ymd(to)
  const months = (y2 - y1) * 12 + (m2 - m1)
  switch (frequency) {
    case 'monthly':
      return months + 1
    case 'semi_monthly':
      return months * 2 + (d2 > 15 ? 1 : 0) - (d1 > 15 ? 1 : 0) + 1
    case 'weekly':
      return Math.floor((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / (7 * 86_400_000)) + 1
  }
}

/**
 * Withholding for one payroll: the regular method, or CAM when a trigger
 * applies now or applied earlier this year.
 *
 * Our readings, where the spec is silent: trigger (b) needs S above 0 (a
 * payroll with no pay at all is not "S at least R"); a 13th-month payslip
 * carries no regular pay of its own, so its R of 0 does not count as the 0%
 * row for trigger (a); payrolls paid before this rule count for the
 * triggers with R and S as they were taxed.
 */
export function periodWithholding(i: PeriodWithholdingInput): PeriodWithholding {
  const R = i.regular
  const S = i.supplementary
  const zeroRow = (r: number) => bracketFor(r, i.brackets).rate === 0
  // the year to date: a payroll paid after this one (finalized out of order) doesn't count
  const facts = i.ytd.filter((f) => f.payDate <= i.payDate).sort((a, b) => a.payDate.localeCompare(b.payDate))

  // a trigger in an earlier payroll keeps CAM on for the rest of the year
  let since: string | undefined
  let sToDate = 0
  for (const f of facts) {
    sToDate = round2(sToDate + f.supplementary)
    const a = !f.supplementaryOnly && zeroRow(f.regular) && sToDate > 0
    const b = f.supplementary > 0 && f.supplementary >= f.regular
    if (f.method === 'cam' || a || b) {
      since = f.payDate
      break
    }
  }
  const prior = i.prior ?? null
  const sYear = round2(facts.reduce((s, f) => s + f.supplementary, 0) + S)
  const trigger: CamTrigger | undefined =
    !i.supplementaryOnly && zeroRow(R) && sYear > 0
      ? 'a'
      : S > 0 && S >= R
        ? 'b'
        : prior
          ? 'c'
          : since
            ? 'earlier'
            : undefined
  if (!trigger) return { tax: regularMethodTax(R, S, i.brackets), method: 'regular' }

  // n: from the first period of the year with compensation from any employer
  const yearStart = `${i.payDate.slice(0, 4)}-01-01`
  const starts = facts.filter((f) => f.gross > 0).map((f) => f.payDate)
  if (prior) starts.push(prior.employedFrom && prior.employedFrom > yearStart ? prior.employedFrom : yearStart)
  const from = starts.reduce((a, b) => (b < a ? b : a), i.payDate)
  const n = periodsBetween(i.frequency, from, i.payDate)

  const cumC =
    facts.reduce((s, f) => s + cents(f.regular) + cents(f.supplementary), 0n) + cents(R) + cents(S) + (prior ? cents(prior.taxable) : 0n)
  const withheldC = facts.reduce((s, f) => s + cents(f.withheld), 0n) + (prior ? cents(prior.withheld) : 0n)
  const totalDue = camTotalDue(pesos(cumC), n, i.brackets)
  const taxC = cents(totalDue) - withheldC
  return {
    tax: taxC > 0n ? pesos(taxC) : 0,
    method: 'cam',
    trigger,
    n,
    from,
    cum: pesos(cumC),
    totalDue,
    withheldBefore: pesos(withheldC),
    since,
  }
}

/** The stored payslip columns R and S are read from. */
export interface WithholdingPayslipRow {
  pay_date: string
  run_type: string
  is_minimum_wage_earner: boolean
  earnings: { code?: string; amount: number | string; bir?: BirBucket; taxable?: boolean }[]
  taxable_income: number | string
  taxable_regular?: number | string | null
  taxable_supplementary?: number | string | null
  wht_method?: WhtMethod | null
  withholding_tax: number | string
  gross_pay: number | string
  sss_ee: number | string
  sss_mpf_ee: number | string
  philhealth_ee: number | string
  pagibig_ee: number | string
  union_dues: number | string
}

/** Allowance buckets paid as regular compensation (before pay codes, every allowance was paid each period). */
const REGULAR_ALLOWANCE_BUCKETS: readonly BirBucket[] = ['representation', 'transportation', 'cola', 'housing', 'other_taxable']

/**
 * R and S of a finalized payslip. A payslip from before this rule has no
 * stored split: R is its taxable basic pay and fixed allowances less the
 * contributions and union dues (which came out of basic pay first, and out
 * of a minimum wage earner's exempt basic pay first), and S is the rest of
 * its taxable compensation.
 */
export function withholdingFactOf(p: WithholdingPayslipRow): WithholdingYtdFact {
  const common = {
    payDate: p.pay_date,
    withheld: Number(p.withholding_tax),
    gross: Number(p.gross_pay),
    ...(p.run_type === 'thirteenth_month' ? { supplementaryOnly: true } : {}),
  }
  if (p.taxable_regular != null && p.taxable_supplementary != null) {
    return {
      ...common,
      regular: Number(p.taxable_regular),
      supplementary: Number(p.taxable_supplementary),
      method: p.wht_method ?? undefined,
    }
  }
  let regularLines = 0
  let basicLines = 0
  for (const l of p.earnings) {
    const amount = Number(l.amount)
    if (l.bir === 'basic') basicLines += amount
    const regular = l.bir === 'basic' || (l.code === 'allowance' && !!l.bir && REGULAR_ALLOWANCE_BUCKETS.includes(l.bir))
    if (l.taxable && regular) regularLines += amount
  }
  const exclusions =
    Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee) + Number(p.union_dues)
  const carve = p.is_minimum_wage_earner ? Math.max(0, exclusions - Math.max(0, basicLines)) : exclusions
  const regular = round2(Math.max(0, regularLines - carve))
  return { ...common, regular, supplementary: round2(Math.max(0, Number(p.taxable_income) - regular)) }
}
