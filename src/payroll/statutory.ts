// Statutory contribution and withholding tax calculators.
// All figures come from versioned tables (statutory_versions in Supabase) —
// nothing here hardcodes a rate, so updating the law means inserting a new
// table version, not changing code.

import {
  round2,
  type BirWhtData,
  type PagibigData,
  type PhilHealthData,
  type SssComputation,
  type SssTableData,
  type TaxBracket,
} from './types'

/**
 * Map actual monthly compensation to the SSS Monthly Salary Credit.
 * Published brackets are `msc - step/2 .. msc + step/2 - 0.01`
 * (e.g. 5,250–5,749.99 -> MSC 5,500), clamped to the min/max MSC.
 */
export function sssMsc(monthlySalary: number, t: SssTableData): number {
  const bracket = Math.floor((monthlySalary + t.msc_step / 2) / t.msc_step) * t.msc_step
  return Math.min(t.msc_max, Math.max(t.msc_min, bracket))
}

/**
 * SSS contribution for one month. MSC up to `mpf_threshold` funds the regular
 * program; the portion above it funds the Mandatory Provident Fund (WISP).
 * The employer additionally pays Employees' Compensation (EC).
 */
export function computeSss(monthlySalary: number, t: SssTableData): SssComputation {
  const msc = sssMsc(monthlySalary, t)
  const regularBase = Math.min(msc, t.mpf_threshold)
  const mpfBase = Math.max(0, msc - t.mpf_threshold)
  return {
    msc,
    ee: round2(regularBase * t.rate_ee),
    er: round2(regularBase * t.rate_er),
    ecEr: msc < t.ec_threshold_msc ? t.ec_er_low : t.ec_er_high,
    mpfEe: round2(mpfBase * t.rate_ee),
    mpfEr: round2(mpfBase * t.rate_er),
  }
}

/**
 * PhilHealth monthly premium, split equally employer/employee.
 * Odd-centavo rule (official PhilHealth sample computations): when the 50/50
 * split yields a fractional centavo, the employee share rounds DOWN and the
 * employer carries the extra centavo (e.g. ₱618.75 → EE ₱309.37 / ER ₱309.38).
 */
export function computePhilHealth(
  monthlyBasicSalary: number,
  t: PhilHealthData,
): { ee: number; er: number; total: number } {
  const base = Math.min(Math.max(monthlyBasicSalary, t.floor), t.ceiling)
  // Integer-centavo arithmetic: flooring the binary-float half can drop a
  // centavo from the employee even on exact even splits.
  const totalCents = Math.round(base * t.rate * 100)
  const eeCents = Math.floor(totalCents / 2)
  return {
    ee: eeCents / 100,
    er: (totalCents - eeCents) / 100,
    total: totalCents / 100,
  }
}

/** Pag-IBIG (HDMF) monthly savings. Compensation is capped at the max fund salary. */
export function computePagibig(
  monthlyCompensation: number,
  t: PagibigData,
): { ee: number; er: number } {
  const base = Math.min(monthlyCompensation, t.max_fund_salary)
  const eeRate = monthlyCompensation <= t.low_threshold ? t.ee_rate_low : t.ee_rate_high
  return {
    ee: round2(base * eeRate),
    er: round2(base * t.er_rate),
  }
}

/** Progressive tax from a bracket table ({over, base, rate} rows, ascending). */
export function taxFromBrackets(taxable: number, brackets: TaxBracket[]): number {
  if (taxable <= 0) return 0
  let b = brackets[0]
  for (const bracket of brackets) {
    if (taxable > bracket.over || bracket.over === 0) b = bracket
    else break
  }
  return round2(b.base + b.rate * (taxable - b.over))
}

export type WhtPeriod = 'daily' | 'weekly' | 'semi_monthly' | 'monthly'

/**
 * Withholding tax on compensation for one pay period (BIR revised withholding
 * tax tables, effective 01 Jan 2023 onward under the TRAIN law).
 * `taxable` must already exclude mandatory contributions (SSS incl. MPF,
 * PhilHealth, Pag-IBIG employee shares) and non-taxable earnings.
 */
export function computeWithholdingTax(
  taxable: number,
  period: WhtPeriod,
  t: BirWhtData,
): number {
  return taxFromBrackets(taxable, t[period])
}
