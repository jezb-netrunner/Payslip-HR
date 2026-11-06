// Opening balances: what THIS employer paid and withheld in a tax year before
// the client went live on the app (its payroll ran elsewhere). Not a previous
// employer (employee_tax_years): the amounts are the present employer's, so
// they enter the year as one more payslip — the present employer's BIR Form
// 2316 columns, "taxes withheld as adjusted", the 13th month and other
// benefits' ₱90,000 exemption, the cumulative average method's year to date,
// and the 13th month's basic salary earned (PD 851).
//
// Pay released on or before `paid_through` belongs to the old payroll; a
// payroll of the app paid by then would be counted twice.

import type { EmployeeOpeningBalance } from '../lib/db'
import { NO_PRIOR_EMPLOYER, summarizeYear, type AnnualPayslipFact, type PriorEmployerInput } from './annual'
import { round2, type BirAnnualData, type BirBucket } from './types'

/** The amount columns (every number but the year). */
export type AmountKey = Exclude<
  { [K in keyof EmployeeOpeningBalance]: EmployeeOpeningBalance[K] extends number ? K : never }[keyof EmployeeOpeningBalance],
  'year'
>

export type OpeningGroup = 'regular' | 'supplementary' | 'benefits'

/** Each pay column, the BIR Form 2316 column (bucket) it goes to, and its screen label. */
export const OPENING_EARNINGS: { key: AmountKey; bir: BirBucket; group: OpeningGroup; label: string }[] = [
  { key: 'basic_salary', bir: 'basic', group: 'regular', label: 'Basic salary (SMW for an MWE)' },
  { key: 'cola', bir: 'cola', group: 'regular', label: 'Cost of living allowance' },
  { key: 'representation', bir: 'representation', group: 'regular', label: 'Representation' },
  { key: 'transportation', bir: 'transportation', group: 'regular', label: 'Transportation (taxable)' },
  { key: 'housing', bir: 'housing', group: 'regular', label: 'Fixed housing allowance' },
  { key: 'other_taxable_regular', bir: 'other_taxable', group: 'regular', label: 'Other taxable regular pay (allowances)' },
  { key: 'holiday_pay', bir: 'holiday', group: 'supplementary', label: 'Holiday pay' },
  { key: 'premium_pay', bir: 'premium', group: 'supplementary', label: 'Rest-day & special-day premiums' },
  { key: 'overtime_pay', bir: 'overtime', group: 'supplementary', label: 'Overtime pay' },
  { key: 'night_diff', bir: 'night_diff', group: 'supplementary', label: 'Night differential' },
  { key: 'hazard_pay', bir: 'hazard', group: 'supplementary', label: 'Hazard pay' },
  { key: 'commission', bir: 'commission', group: 'supplementary', label: 'Commission' },
  { key: 'profit_sharing', bir: 'profit_sharing', group: 'supplementary', label: 'Profit sharing' },
  { key: 'fees', bir: 'fees', group: 'supplementary', label: 'Fees' },
  { key: 'other_supplementary', bir: 'other_supplementary', group: 'supplementary', label: 'Other taxable supplementary pay' },
  { key: 'thirteenth_month', bir: 'thirteenth', group: 'benefits', label: '13th month pay (all of it, before the ₱90,000 cap)' },
  { key: 'other_benefits', bir: 'other_benefits', group: 'benefits', label: 'Other benefits / bonuses (before the cap)' },
  { key: 'de_minimis', bir: 'de_minimis', group: 'benefits', label: 'De minimis benefits (within the ceilings)' },
  { key: 'other_non_taxable', bir: 'other_non_taxable', group: 'benefits', label: 'Other non-taxable pay' },
]

/** Every amount column of an opening balance, the pay columns first. */
export const OPENING_AMOUNT_KEYS: AmountKey[] = [
  ...OPENING_EARNINGS.map((f) => f.key),
  'contributions',
  'tax_withheld',
  'thirteenth_basis',
  'thirteenth_installments',
]

const num = (v: unknown) => Number(v ?? 0) || 0

/**
 * The opening balance as one payslip of the year, dated its last pay date.
 * A minimum wage earner's hazard pay is exempt only with the hazardous-
 * assignment certification, as on the app's own payslips.
 */
export function openingFact(o: EmployeeOpeningBalance, opts: { hazardCertified?: boolean } = {}): AnnualPayslipFact {
  const isMwe = !!o.minimum_wage_earner
  return {
    payMonth: `${o.paid_through.slice(0, 7)}-01`,
    payDate: o.paid_through,
    isMwe,
    earnings: OPENING_EARNINGS.map((f) => ({
      amount: num(o[f.key]),
      bir: f.bir,
      ...(isMwe && f.bir === 'hazard' && !opts.hazardCertified ? { taxable: true } : {}),
    })).filter((l) => l.amount !== 0),
    // union dues are entered with the contributions
    contributionsEe: num(o.contributions),
    unionDues: 0,
    withholdingTax: num(o.tax_withheld),
  }
}

/**
 * Taxable compensation the opening balance adds to the year (the cumulative
 * average method's year to date): its pay less the exempt part, with the
 * exemption left after a previous employer's.
 */
export function openingTaxable(
  o: EmployeeOpeningBalance,
  annual: BirAnnualData,
  prior: PriorEmployerInput = NO_PRIOR_EMPLOYER,
  opts: { hazardCertified?: boolean } = {},
): number {
  return summarizeYear([openingFact(o, opts)], annual, prior).totalTaxablePresent
}

/** 13th month pay and other benefits the opening balance paid (they share the ₱90,000 exemption). */
export function openingBenefits(o: EmployeeOpeningBalance): number {
  return round2(num(o.thirteenth_month) + num(o.other_benefits))
}

/** Pay released after the opening balance: only then does it count as earlier in the year. */
export function openingAppliesTo(o: EmployeeOpeningBalance | undefined, payDate: string): o is EmployeeOpeningBalance {
  return !!o && o.paid_through < payDate
}

/**
 * Pay dates of the app's own payslips that the opening balance already
 * covers (paid on or before `paid_through`): counted twice.
 */
export function openingOverlaps(o: EmployeeOpeningBalance | undefined, payDates: (string | null | undefined)[]): string[] {
  if (!o) return []
  return [...new Set(payDates.filter((d): d is string => !!d && d <= o.paid_through))].sort()
}

/** The warning for payslips the opening balance already covers, or ''. */
export function overlapWarning(o: EmployeeOpeningBalance, overlaps: string[]): string {
  if (overlaps.length === 0) return ''
  const list = overlaps.length > 3 ? `${overlaps.slice(0, 3).join(', ')} and ${overlaps.length - 3} more` : overlaps.join(', ')
  return `Opening balances cover pay through ${o.paid_through}, but finalized payrolls in the app were paid on ${list}: that pay and tax is counted twice. Correct the "paid through" date or the opening balances (employee's BIR tab).`
}

/** An opening balance with every amount at zero (a new entry, or a test's starting point). */
export function blankOpening(employeeId: string, year: number, paidThrough: string): EmployeeOpeningBalance {
  const amounts = Object.fromEntries(OPENING_AMOUNT_KEYS.map((k) => [k, 0])) as Record<AmountKey, number>
  return {
    id: '',
    employee_id: employeeId,
    entity_id: '',
    year,
    paid_through: paidThrough,
    minimum_wage_earner: false,
    periods_paid: null,
    notes: '',
    ...amounts,
  }
}
