// Display labels and BIR codes shared across pages.

import type { EmploymentStatus, MaternityExemptionCategory, PaymentMethod, SeparationReason } from './db'
import type {
  AllowanceBasis,
  ContributionTiming,
  IncomeClass,
  PayCodeTaxTreatment,
  PayFrequency,
  RoundingMode,
} from '../payroll/types'

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

export const ALLOWANCE_BASIS_LABELS: Record<AllowanceBasis, string> = {
  monthly: 'per month (split across payrolls)',
  per_period: 'per payroll',
  per_day: 'per paid day',
}

/** RA 11210 Sec. 5(c): who may be exempted, with DOLE approval each year, from the maternity salary differential. */
export const MATERNITY_EXEMPTION_LABELS: Record<MaternityExemptionCategory, string> = {
  distressed: 'Distressed establishment',
  small_retail_service: 'Retail or service establishment, or other enterprise, with 10 or fewer workers',
  micro_business: 'Micro-business enterprise in the listed sectors, total assets ₱3,000,000 or less',
  equal_or_better: 'Employer already giving equal or better maternity benefits',
}

/** How a pay code's line is taxed (spec T2). */
export const PAY_CODE_TAX_LABELS: Record<PayCodeTaxTreatment, string> = {
  taxable: 'Taxable',
  mwe_exempt: 'Taxable, exempt for minimum wage earners',
  benefits: '₱90k bucket: taxable above ₱90,000 a year',
  de_minimis: 'De minimis: non-taxable within the ceiling',
  exempt: 'Non-taxable',
}

/** Regular (R) or supplementary (S) compensation. */
export const INCOME_CLASS_LABELS: Record<IncomeClass, string> = {
  regular: 'Regular (R)',
  supplementary: 'Supplementary (S)',
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

/** The solo-parent PhilHealth rule's first day (PhilHealth Circular 2026-0015). */
export const SOLO_PARENT_PHILHEALTH_FROM = '2026-09-26'

/** Why a PhilHealth employee-share waiver can't be saved ('' = fine). */
/**
 * The NG share form (spec T6): the start month (YYYY-MM), and the solo
 * parent's SPIC expiry. A PWD's status defaults to "for verification".
 */
export function philhealthWaiverProblem(kind: string, startMonth: string, spicExpiry: string): string {
  if (!kind) return ''
  if (!/^\d{4}-\d{2}$/.test(startMonth)) return 'Enter the month the government starts paying the PhilHealth employee share.'
  if (kind === 'solo_parent' && `${startMonth}-01` < SOLO_PARENT_PHILHEALTH_FROM.slice(0, 7) + '-01') {
    return 'For solo parents the government pays the PhilHealth employee share from Sep 26, 2026 (PhilHealth Circular 2026-0015).'
  }
  if (kind === 'solo_parent' && !spicExpiry) return "Enter the solo parent ID (SPIC)'s expiry date: only months it fully covers are waived."
  return ''
}
