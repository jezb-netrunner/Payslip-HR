// Withholding on compensation for one payroll period when supplementary pay
// (overtime, premiums, commissions, taxable bonuses, other taxable
// benefits) is paid beside regular pay.
//
// Basis: RR 2-98 Sec. 2.79(B)(3) Steps 1–4 and Sec. 2.79(B)(5)(a) as amended
// by RR 11-2018; withholding tables RR 11-2018 Annex E.
//  - Default: the bracket is picked from the taxable regular pay only, and
//    its fixed tax and rate apply to regular + supplementary pay.
//  - Cumulative average method, when (a) the regular pay is in the zero
//    bracket and supplementary pay is paid, (b) supplementary pay is at
//    least the regular pay, or (c) the employee had another employer earlier
//    in the year: average the year's taxable pay over the payroll periods,
//    tax the average, multiply back, and withhold what the year still owes.
//    Once used, it stays for the rest of the year.
// Every step rounds half-up to the centavo.

import { addDays } from '../lib/manila'
import { bracketOf } from './statutory'
import { round2, type BirBucket, type PayFrequency, type TaxBracket, type TaxTrace } from './types'

export type WhtMethod = TaxTrace['method']

/**
 * Regular compensation: basic salary and fixed allowances (2316 items
 * 39–44). Every other taxable pay is supplementary (items 45–51).
 */
export const REGULAR_COMPENSATION_BUCKETS: readonly BirBucket[] = [
  'basic', 'representation', 'transportation', 'cola', 'housing', 'other_taxable',
]

/** The tax year so far, for the cumulative average method. */
export interface TaxYearToDate {
  /** taxable pay paid earlier this year, earlier employers' included */
  taxableBefore: number
  /** tax withheld earlier this year, earlier employers' included */
  withheldBefore: number
  /** payroll periods of this frequency from 1 January (or the first employment this year) through this one */
  periods: number
  /** the method is already in use this year, or there was an earlier employer this year */
  cumulative: boolean
}

export interface PeriodTaxInput {
  /** taxable regular pay of the period, after contributions and exclusions */
  regular: number
  /** taxable supplementary pay of the period */
  supplementary: number
  /** the withholding table of the pay frequency */
  brackets: TaxBracket[]
  /** omitted = no history (the year's first payroll) */
  taxYear?: TaxYearToDate
}

export interface PeriodTax {
  tax: number
  method: WhtMethod
  /** cumulative average method: the year's taxable pay, its average and the periods */
  cumulative?: number
  average?: number
  periods?: number
}

function tableTax(taxable: number, b: TaxBracket): number {
  return taxable <= 0 ? 0 : round2(b.base + b.rate * (taxable - b.over))
}

export function periodWithholding(i: PeriodTaxInput): PeriodTax {
  const regular = round2(i.regular)
  const supplementary = round2(i.supplementary)
  const bracket = bracketOf(regular, i.brackets)
  const zeroBracket = bracket.rate === 0 && bracket.base === 0
  const cumulative =
    (i.taxYear?.cumulative ?? false) ||
    (supplementary > 0 && (zeroBracket || supplementary >= regular))
  if (cumulative) {
    const ytd = i.taxYear ?? { taxableBefore: 0, withheldBefore: 0, periods: 1, cumulative: true }
    const periods = Math.max(1, ytd.periods)
    const cum = round2(ytd.taxableBefore + regular + supplementary)
    const average = round2(cum / periods)
    const taxOnAverage = tableTax(average, bracketOf(average, i.brackets))
    const cumTax = round2(taxOnAverage * periods)
    return {
      tax: round2(Math.max(0, cumTax - ytd.withheldBefore)),
      method: 'cumulative_average',
      cumulative: cum,
      average,
      periods,
    }
  }
  if (supplementary <= 0) return { tax: tableTax(regular, bracket), method: 'table' }
  return { tax: tableTax(regular + supplementary, bracket), method: 'supplementary' }
}

/**
 * Payroll periods of a frequency from `from` (1 January, or the first
 * employment this year) through the period ending `to`, both in one year.
 */
export function periodsThisYear(frequency: PayFrequency, from: string, to: string): number {
  if (to < from) return 1
  const month = (d: string) => Number(d.slice(5, 7))
  if (frequency === 'monthly') return month(to) - month(from) + 1
  if (frequency === 'semi_monthly') {
    const half = (d: string) => (month(d) - 1) * 2 + (Number(d.slice(8, 10)) <= 15 ? 0 : 1)
    return half(to) - half(from) + 1
  }
  let n = 1
  for (let d = addDays(from, 7); d <= to; d = addDays(d, 7)) n += 1
  return n
}
