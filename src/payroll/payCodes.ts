// Pay codes (spec T2; owner's decision, 2026-10-25): every earnings line an
// admin enters — a recurring allowance or a one-time earning in a payroll —
// carries one. The code fixes the line's BIR bucket (how it is taxed and
// reported) and whether its taxable part is regular (R) or supplementary (S)
// compensation, which the withholding method needs. The codes are reference
// data in the pay_codes table, shipped by migration like the statutory
// tables; this list mirrors it for tests (supabase/tests/18_pay_codes_tests.sql
// checks the two agree).

import type { AllowanceCategory, BirBucket, DeMinimisItem, IncomeClass, MaternityBenefit, PayCode } from './types'

interface CodeSpec {
  /** where it is offered: allowances (A), one-time earnings (O), or neither (a code the payroll uses itself) */
  use: 'A' | 'O' | 'AO' | ''
  bir_bucket: BirBucket
  income_class: IncomeClass | null
  tax_treatment: PayCode['tax_treatment']
  /** in the SSS base; '?' = a setting, excluded until the law is confirmed (P2, P3) */
  sss: boolean | '?'
  description: string
  /** whether it is taxable is a setting (P1) */
  taxPending?: boolean
  /** counts toward the 13th month besides basic pay; '?' = a setting, included until confirmed (P9) */
  thirteenth?: boolean | '?'
  /** the de minimis item whose ceiling applies */
  item?: DeMinimisItem
  /** offered for new rows (a retired code keeps working on the rows that have it) */
  active?: boolean
  benefit?: MaternityBenefit
  is_christmas_bonus?: boolean
  subject_to_liquidation?: boolean
}

const code = (sort_order: number, c: string, label: string, x: CodeSpec): PayCode => ({
  code: c,
  label,
  description: x.description,
  for_allowances: x.use.includes('A'),
  for_one_time: x.use.includes('O'),
  bir_bucket: x.bir_bucket,
  income_class: x.income_class,
  tax_treatment: x.tax_treatment,
  tax_pending: x.taxPending ?? false,
  include_in_13th_month_base: x.thirteenth === true || x.thirteenth === '?',
  thirteenth_pending: x.thirteenth === '?',
  benefit: x.benefit ?? null,
  de_minimis_item: x.item ?? null,
  sss_include: x.sss === true,
  sss_include_pending: x.sss === '?',
  is_christmas_bonus: x.is_christmas_bonus ?? false,
  subject_to_liquidation: x.subject_to_liquidation ?? false,
  sort_order,
  active: x.active ?? true,
})

export const PAY_CODES: readonly PayCode[] = [
  code(10, 'BASIC_ADJ', 'Basic pay adjustment', { use: 'O', bir_bucket: 'basic', income_class: 'regular', tax_treatment: 'mwe_exempt', sss: true, thirteenth: true,
    description: 'A correction of basic pay of an earlier payroll. Counts toward the 13th month.' }),
  code(12, 'WAGE_ORDER_TOPUP', 'Wage order top-up', { use: 'O', bir_bucket: 'basic', income_class: 'regular', tax_treatment: 'mwe_exempt', sss: true, thirteenth: true,
    description: 'The difference a new wage order adds to basic pay, for days already paid at the old rate. For a minimum wage earner it is statutory minimum wage (exempt); for others, regular compensation.' }),
  code(20, 'HOLIDAY_ADJ', 'Holiday, rest day or special day pay adjustment', { use: 'O', bir_bucket: 'holiday', income_class: 'supplementary', tax_treatment: 'mwe_exempt', sss: true,
    description: 'Holiday, rest-day or special-day pay of an earlier payroll.' }),
  code(30, 'OVERTIME_ADJ', 'Overtime pay adjustment', { use: 'O', bir_bucket: 'overtime', income_class: 'supplementary', tax_treatment: 'mwe_exempt', sss: true,
    description: 'Overtime of an earlier payroll.' }),
  code(40, 'NIGHT_DIFF_ADJ', 'Night differential adjustment', { use: 'O', bir_bucket: 'night_diff', income_class: 'supplementary', tax_treatment: 'mwe_exempt', sss: true,
    description: 'Night shift differential of an earlier payroll.' }),
  code(50, 'REPRESENTATION', 'Representation allowance', { use: 'AO', bir_bucket: 'representation', income_class: 'regular', tax_treatment: 'taxable', sss: true,
    description: 'Fixed representation allowance. Regular compensation when paid every period.' }),
  code(60, 'TRANSPORTATION', 'Transportation allowance', { use: 'AO', bir_bucket: 'transportation', income_class: 'regular', tax_treatment: 'taxable', sss: true,
    description: 'Fixed transportation allowance, not liquidated. Regular compensation when paid every period.' }),
  code(70, 'COLA', 'Cost of living allowance (COLA)', { use: 'AO', bir_bucket: 'cola', income_class: 'regular', tax_treatment: 'mwe_exempt', sss: true,
    description: 'COLA fixed by a wage order. Exempt for minimum wage earners.' }),
  code(80, 'HOUSING', 'Fixed housing allowance', { use: 'AO', bir_bucket: 'housing', income_class: 'regular', tax_treatment: 'taxable', sss: true,
    description: 'Fixed housing, board or lodging allowance, not liquidated. Regular compensation when paid every period.' }),
  code(90, 'FIXED_ALLOWANCE', 'Other fixed allowance', { use: 'A', bir_bucket: 'other_taxable', income_class: 'regular', tax_treatment: 'taxable', sss: true,
    description: 'Any other taxable allowance paid every period.' }),
  code(95, 'LIQUIDATED_ALLOWANCE', 'Transportation, board or lodging (liquidated)', { use: 'AO', bir_bucket: 'other_non_taxable', income_class: null, tax_treatment: 'exempt', sss: false,
    subject_to_liquidation: true,
    description: 'An allowance or reimbursement the employee liquidates with receipts. Not compensation, so not taxed and not in the SSS base.' }),
  code(100, 'HAZARD', 'Hazard pay', { use: 'AO', bir_bucket: 'hazard', income_class: 'supplementary', tax_treatment: 'mwe_exempt', sss: true,
    description: 'Hazard pay. Supplementary compensation. Exempt for minimum wage earners.' }),
  code(110, 'COMMISSION', 'Commission', { use: 'O', bir_bucket: 'other_taxable', income_class: 'supplementary', tax_treatment: 'taxable', sss: true,
    description: 'Sales or other commission, commission advances included.' }),
  code(120, 'OTHER_TAXABLE', 'Other taxable pay', { use: 'O', bir_bucket: 'other_taxable', income_class: 'supplementary', tax_treatment: 'taxable', sss: true,
    description: 'Any other taxable one-time pay, such as an incentive outside the ₱90k bucket or the cash value of non-cash pay.' }),
  code(130, 'BONUS', 'Other bonus or benefit (₱90k bucket)', { use: 'AO', bir_bucket: 'other_benefits', income_class: 'supplementary', tax_treatment: 'benefits', sss: true,
    description: 'Bonuses and other benefits other than the Christmas bonus. Exempt together with the 13th month pay up to ₱90,000 a year, the excess is supplementary compensation. In the SSS base.' }),
  code(135, 'CHRISTMAS_BONUS', 'Christmas bonus (₱90k bucket)', { use: 'O', bir_bucket: 'other_benefits', income_class: 'supplementary', tax_treatment: 'benefits', sss: false,
    is_christmas_bonus: true,
    description: 'The Christmas bonus. In the ₱90k bucket for tax, and out of the SSS base.' }),
  code(140, 'DE_MINIMIS', 'De minimis benefit (no item)', { use: 'AO', bir_bucket: 'de_minimis', income_class: 'supplementary', tax_treatment: 'de_minimis', sss: '?',
    active: false,
    description: 'Retired: a de minimis benefit saved before the items. Its ceiling is not checked; change it to the item\'s pay code.' }),
  ...([
    [141, 'DM_MEDICAL_DEPENDENTS', 'Medical cash allowance to dependents (de minimis)', 'c', 'AO'],
    [142, 'DM_RICE', 'Rice subsidy (de minimis)', 'd', 'AO'],
    [143, 'DM_UNIFORM', 'Uniform and clothing allowance (de minimis)', 'e', 'AO'],
    [144, 'DM_MEDICAL_ASSISTANCE', 'Actual medical assistance (de minimis)', 'f', 'AO'],
    [145, 'DM_LAUNDRY', 'Laundry allowance (de minimis)', 'g', 'AO'],
    [146, 'DM_ACHIEVEMENT', 'Employee achievement award (de minimis)', 'h', 'O'],
    [147, 'DM_GIFTS', 'Christmas or anniversary gift (de minimis)', 'i', 'O'],
    [148, 'DM_MEAL', 'Meal allowance for overtime or night shift (de minimis)', 'j', 'AO'],
    [149, 'DM_CBA_PRODUCTIVITY', 'CBA or productivity incentive (de minimis)', 'k', 'O'],
  ] as const).map(([sort, c, label, item, use]) =>
    code(sort, c, label, { use, bir_bucket: 'de_minimis', income_class: 'supplementary', tax_treatment: 'de_minimis', sss: '?', item,
      description: `De minimis item (${item}) of RR 29-2025: exempt up to its ceiling, the excess goes to the ₱90k bucket.` }),
  ),
  code(125, 'LEAVE_CONVERSION', 'Cash conversion of unused leave', { use: 'O', bir_bucket: 'de_minimis', income_class: 'supplementary', tax_treatment: 'de_minimis', sss: '?',
    item: 'a',
    description: 'Unused leave paid in cash, with the days converted. A client giving vacation leave in place of SIL: de minimis up to 12 days a year, the rest to the ₱90k bucket. A client giving SIL only: SIL conversion, taxable supplementary compensation.' }),
  code(150, 'NON_TAXABLE', 'Other non-taxable pay', { use: 'AO', bir_bucket: 'other_non_taxable', income_class: null, tax_treatment: 'exempt', sss: '?',
    description: 'Other pay the law exempts from tax.' }),
  code(160, 'MAT_SSS_BENEFIT', 'SSS maternity benefit', { use: 'O', bir_bucket: 'other_non_taxable', income_class: null, tax_treatment: 'exempt', sss: '?',
    benefit: 'sss_maternity',
    description: 'The SSS maternity benefit the employer advances (RA 11210). Tax-exempt.' }),
  code(170, 'MAT_DIFFERENTIAL', 'Maternity salary differential', { use: 'O', bir_bucket: 'other_taxable', income_class: 'supplementary', tax_treatment: 'taxable', sss: true,
    benefit: 'maternity_differential', taxPending: true, thirteenth: '?',
    description: 'The salary differential up to full pay during maternity leave (RA 11210). Taxable as supplementary compensation until the tax exemption is confirmed (a setting). In the SSS base. Counts toward the 13th month (a setting).' }),
  code(900, 'THIRTEENTH_MONTH', '13th month pay', { use: '', bir_bucket: 'thirteenth', income_class: 'supplementary', tax_treatment: 'benefits', sss: '?',
    description: '13th month pay (PD 851), paid by a 13th month run. Exempt together with other benefits up to ₱90,000 a year.' }),
]

/** The code's definition; an unknown code is an error, never a silent default. */
export function payCodeOf(c: string, codes: readonly PayCode[] = PAY_CODES): PayCode {
  const found = codes.find((x) => x.code === c)
  if (!found) throw new Error(`Unknown pay code ${c}.`)
  return found
}

// Rows saved before pay codes carry only a category: the code each gets
// (the database's default_pay_code does the same).
const ALLOWANCE_CODE: Record<AllowanceCategory, string> = {
  de_minimis: 'DE_MINIMIS',
  other_benefits: 'BONUS',
  hazard: 'HAZARD',
  representation: 'REPRESENTATION',
  transportation: 'TRANSPORTATION',
  cola: 'COLA',
  housing: 'HOUSING',
  other_taxable: 'FIXED_ALLOWANCE',
  other_non_taxable: 'NON_TAXABLE',
}

const ONE_TIME_CODE: Partial<Record<BirBucket, string>> = {
  basic: 'BASIC_ADJ',
  holiday: 'HOLIDAY_ADJ',
  overtime: 'OVERTIME_ADJ',
  night_diff: 'NIGHT_DIFF_ADJ',
  hazard: 'HAZARD',
  other_benefits: 'BONUS',
  de_minimis: 'DE_MINIMIS',
  representation: 'REPRESENTATION',
  transportation: 'TRANSPORTATION',
  cola: 'COLA',
  housing: 'HOUSING',
  other_taxable: 'OTHER_TAXABLE',
  other_non_taxable: 'NON_TAXABLE',
}

export function payCodeForAllowanceCategory(category: AllowanceCategory): string {
  return ALLOWANCE_CODE[category]
}

export function payCodeForEarningCategory(category: BirBucket, benefit?: MaternityBenefit | null): string {
  if (benefit === 'sss_maternity') return 'MAT_SSS_BENEFIT'
  if (benefit === 'maternity_differential') return 'MAT_DIFFERENTIAL'
  const c = ONE_TIME_CODE[category]
  if (!c) throw new Error(`No pay code for one-time ${category} pay.`)
  return c
}

/**
 * R or S of a line's taxable part. An allowance paid every period takes its
 * code's class; anything paid once is supplementary — R is basic salary and
 * the fixed allowances "paid each period" — except a basic pay correction,
 * which is basic salary.
 */
export function lineIncomeClass(c: PayCode, usage: 'allowance' | 'one_time'): IncomeClass {
  if (usage === 'allowance') return c.income_class ?? 'supplementary'
  return c.bir_bucket === 'basic' ? 'regular' : 'supplementary'
}
