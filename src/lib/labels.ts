// Display labels and BIR codes shared across pages.

import type { EmploymentStatus, PaymentMethod, SeparationReason } from './db'
import type { AllowanceBasis, AllowanceCategory, BirBucket, ContributionTiming, MaternityBenefit, PayFrequency, PayItemType, RoundingMode } from '../payroll/types'
import type { PayRateReason } from '../payroll/payRates'

export const FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  semi_monthly: 'Semi-monthly',
  monthly: 'Monthly',
}

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  regular: 'Regular',
  probationary: 'Probationary',
  casual: 'Casual',
  contractual: 'Contractual',
  project_based: 'Project-based',
  seasonal: 'Seasonal',
  apprentice: 'Apprentice / Learner',
}

/** BIR alphalist employment status codes (RMC 73-2019). */
export const EMPLOYMENT_STATUS_BIR: Record<EmploymentStatus, string> = {
  regular: 'R',
  probationary: 'P',
  casual: 'C',
  contractual: 'CP',
  project_based: 'CP',
  seasonal: 'S',
  apprentice: 'AL',
}

export const SEPARATION_REASON_LABELS: Record<SeparationReason, string> = {
  resignation: 'Resignation',
  termination: 'Termination',
  end_of_contract: 'End of contract / project',
  retirement: 'Retirement',
  death: 'Death',
  transfer: 'Transfer to another employer',
  other: 'Other',
}

/** BIR alphalist reason-of-separation codes: T terminated/resigned, TR transferred, R retired, D death. */
export const SEPARATION_REASON_BIR: Record<SeparationReason, string> = {
  resignation: 'T',
  termination: 'T',
  end_of_contract: 'T',
  retirement: 'R',
  death: 'D',
  transfer: 'TR',
  other: 'T',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  e_wallet: 'E-wallet',
  check: 'Check',
}

export const ROUNDING_LABELS: Record<RoundingMode, string> = {
  none: 'Exact centavos',
  round_up: 'Round up to the next peso (employer absorbs the centavos)',
  carry_forward: 'Pay whole pesos, carry centavos to the next payroll',
}

export const CONTRIBUTION_TIMING_LABELS: Record<ContributionTiming, string> = {
  split: 'Split evenly across the month’s payrolls',
  first_period: 'All on the first payroll of the month',
  last_period: 'All on the last payroll of the month',
}

export const ALLOWANCE_CATEGORY_LABELS: Record<AllowanceCategory, string> = {
  de_minimis: 'De minimis benefit (non-taxable)',
  other_benefits: 'Bonus / other benefits (₱90k cap with 13th month)',
  hazard: 'Hazard pay',
  representation: 'Representation (taxable)',
  transportation: 'Transportation (taxable)',
  cola: 'COLA mandated by a wage order',
  housing: 'Fixed housing allowance (taxable)',
  other_taxable: 'Other taxable allowance',
  other_non_taxable: 'Other non-taxable compensation',
}

export const ALLOWANCE_BASIS_LABELS: Record<AllowanceBasis, string> = {
  monthly: 'per month (split across payrolls)',
  per_period: 'per payroll',
  per_day: 'per paid day',
}

export const BIR_BUCKET_LABELS: Record<BirBucket, string> = {
  basic: 'Basic pay',
  holiday: 'Holiday / premium pay',
  premium: 'Premium pay (MWE, taxable)',
  overtime: 'Overtime pay',
  night_diff: 'Night differential',
  hazard: 'Hazard pay',
  thirteenth: '13th month pay',
  other_benefits: 'Bonus / other benefits',
  de_minimis: 'De minimis',
  representation: 'Representation',
  transportation: 'Transportation',
  cola: 'COLA (wage order)',
  housing: 'Housing allowance',
  other_taxable: 'Other taxable',
  commission: 'Commission',
  profit_sharing: 'Profit sharing',
  fees: 'Fees (directors’ fees included)',
  other_supplementary: 'Other taxable (supplementary)',
  other_non_taxable: 'Other non-taxable',
}

/** RA 11210 maternity pay, paid as one-time earnings (both tax-exempt, RMC 105-2019). */
export const MATERNITY_BENEFIT_LABELS: Record<MaternityBenefit, string> = {
  sss_maternity: 'SSS maternity benefit (tax-exempt)',
  maternity_differential: 'Salary differential (before employee contributions; tax-exempt, counts for 13th month)',
}

/** Wage-board regions (for minimum wage and the MWE alphalist). */
export const PH_REGIONS: { code: string; name: string }[] = [
  { code: 'NCR', name: 'NCR — National Capital Region' },
  { code: 'CAR', name: 'CAR — Cordillera Administrative Region' },
  { code: 'I', name: 'Region I — Ilocos' },
  { code: 'II', name: 'Region II — Cagayan Valley' },
  { code: 'III', name: 'Region III — Central Luzon' },
  { code: 'IV-A', name: 'Region IV-A — CALABARZON' },
  { code: 'IV-B', name: 'MIMAROPA' },
  { code: 'V', name: 'Region V — Bicol' },
  { code: 'VI', name: 'Region VI — Western Visayas' },
  { code: 'NIR', name: 'NIR — Negros Island Region' },
  { code: 'VII', name: 'Region VII — Central Visayas' },
  { code: 'VIII', name: 'Region VIII — Eastern Visayas' },
  { code: 'IX', name: 'Region IX — Zamboanga Peninsula' },
  { code: 'X', name: 'Region X — Northern Mindanao' },
  { code: 'XI', name: 'Region XI — Davao' },
  { code: 'XII', name: 'Region XII — SOCCSKSARGEN' },
  { code: 'XIII', name: 'Region XIII — Caraga' },
  { code: 'BARMM', name: 'BARMM' },
]

export const ROLE_LABELS: Record<string, string> = {
  company_admin: 'Company admin',
  entity_admin: 'Entity admin',
  employee: 'Employee',
}

export const RUN_TYPE_LABELS: Record<string, string> = {
  regular: 'Regular',
  thirteenth_month: '13th month pay',
  special: 'Special / off-cycle',
  final_pay: 'Final pay',
}

export const PAY_RATE_REASON_LABELS: Record<PayRateReason, string> = {
  hired: 'Hired',
  regularized: 'Regularized',
  merit_increase: 'Merit increase',
  promotion: 'Promotion',
  wage_order: 'Wage order',
  adjustment: 'Salary adjustment',
  correction: 'Correction of an earlier entry',
}

/** Allowance categories that can be a reimbursement subject to liquidation (not SSS compensation). */
export const LIQUIDATABLE_CATEGORIES: readonly string[] = ['representation', 'transportation', 'housing', 'other_taxable', 'other_non_taxable']

export const PAY_ITEM_TYPE_LABELS: Record<PayItemType, string> = {
  christmas_bonus: 'Christmas bonus (not SSS compensation)',
  liquidated_allowance: 'Subject to liquidation (not SSS compensation)',
  commission: 'Commission',
  profit_sharing: 'Profit sharing',
  fees: 'Fees (directors’ fees included)',
}

/** Taxable supplementary pay-item types of the "Other taxable" classification (2316 items 45–47). */
export const SUPPLEMENTARY_ITEM_TYPES = ['commission', 'profit_sharing', 'fees'] as const
