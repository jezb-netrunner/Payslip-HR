// Domain types for the Philippine payroll engine.
// Statutory table shapes mirror the `statutory_versions.data` JSONB in Supabase
// so the engine always computes from the versioned tables in the database.

// ---------- statutory table data ----------

export interface SssTableData {
  /** Employee share of the contribution rate (e.g. 0.05 under the 15% schedule). */
  rate_ee: number
  /** Employer share (e.g. 0.10). */
  rate_er: number
  msc_min: number
  msc_max: number
  msc_step: number
  /** MSC above this goes to the Mandatory Provident Fund / WISP (e.g. 20000). */
  mpf_threshold: number
  /** Employer-paid Employees' Compensation: amount when MSC < ec_threshold_msc. */
  ec_er_low: number
  /** EC amount when MSC >= ec_threshold_msc. */
  ec_er_high: number
  ec_threshold_msc: number
}

export interface PhilHealthData {
  rate: number
  floor: number
  ceiling: number
}

export interface PagibigData {
  max_fund_salary: number
  /** Employee rate when monthly compensation <= low_threshold. */
  ee_rate_low: number
  ee_rate_high: number
  low_threshold: number
  er_rate: number
}

export interface TaxBracket {
  /** Compensation level this bracket starts at ("in excess of"). */
  over: number
  /** Tax on the amount at `over`. */
  base: number
  /** Marginal rate applied to the excess over `over`. */
  rate: number
}

export interface BirWhtData {
  daily: TaxBracket[]
  weekly: TaxBracket[]
  semi_monthly: TaxBracket[]
  monthly: TaxBracket[]
}

export interface BirAnnualData {
  brackets: TaxBracket[]
  /** Tax-exempt cap for 13th month pay + other benefits (P90,000). */
  other_benefits_exemption_cap: number
}

export interface StatutoryTables {
  sss: SssTableData
  philhealth: PhilHealthData
  pagibig: PagibigData
  bir_wht: BirWhtData
  bir_annual: BirAnnualData
}

// ---------- attendance ----------

export interface WorkSchedule {
  /** ISO weekdays that are working days (1=Mon .. 7=Sun). */
  days: number[]
  /** "HH:MM" shift start. */
  start: string
  /** "HH:MM" shift end. */
  end: string
  break_minutes: number
}

export interface TimeEntryLite {
  work_date: string
  clock_in: string
  clock_out: string | null
}

export interface HolidayLite {
  holiday_date: string
  name: string
  kind: 'regular' | 'special_non_working' | 'special_working'
}

export interface LeaveLite {
  start_date: string
  end_date: string
  paid: boolean
  type_name: string
}

export type DayType =
  | 'regular'
  | 'rest_day'
  | 'regular_holiday'
  | 'regular_holiday_rest'
  | 'special_day'
  | 'special_day_rest'

export interface DayComputation {
  date: string
  dayType: DayType
  scheduled: boolean
  holidayName?: string
  workedMinutes: number
  /** Worked minutes credited within the standard day. */
  payableMinutes: number
  otMinutes: number
  nightDiffMinutes: number
  /** Portion of nightDiffMinutes falling inside the OT tail of the day. */
  ndOtMinutes: number
  lateMinutes: number
  undertimeMinutes: number
  absent: boolean
  onPaidLeave: boolean
  onUnpaidLeave: boolean
  leaveType?: string
}

// ---------- payroll ----------

export type PayFrequency = 'weekly' | 'semi_monthly' | 'monthly'
/** How monthly SSS/PhilHealth/Pag-IBIG are spread over a month's pay periods. */
export type ContributionTiming = 'split' | 'first_period' | 'last_period'
export type RunType = 'regular' | 'thirteenth_month' | 'special' | 'final_pay'
/**
 * Cash net-pay rounding. 'round_up' pays the next whole peso (employer
 * absorbs < ₱1); 'carry_forward' pays the whole pesos now and the centavos
 * on the next payroll. A plain round-down would be an unauthorized wage
 * deduction (Labor Code Art. 113), so it is not offered.
 */
export type RoundingMode = 'none' | 'round_up' | 'carry_forward'

/**
 * BIR classification of an earnings line — drives the BIR Form 2316 and
 * 1604-C alphalist columns. For minimum wage earners the statutory minimum
 * wage package (basic, holiday, overtime, night differential, hazard pay)
 * is exempt (NIRC Sec. 24(A)(2)).
 */
export type BirBucket =
  | 'basic' //             basic salary / SMW, net of absence, tardiness, undertime lines
  | 'holiday' //           holiday, special-day and rest-day premium pay
  | 'overtime'
  | 'night_diff'
  | 'hazard'
  | 'thirteenth' //        13th month pay
  | 'other_benefits' //    bonuses etc. — shares the ₱90,000 cap with the 13th month
  | 'de_minimis'
  | 'representation'
  | 'transportation'
  | 'cola'
  | 'housing'
  | 'other_taxable'
  | 'other_non_taxable'

export type AllowanceCategory =
  | 'de_minimis'
  | 'other_benefits'
  | 'hazard'
  | 'representation'
  | 'transportation'
  | 'cola'
  | 'housing'
  | 'other_taxable'
  | 'other_non_taxable'

/** monthly: split over the month's pay periods; per_period: every payroll; per_day: per paid day. */
export type AllowanceBasis = 'monthly' | 'per_period' | 'per_day'

export interface PayrollEmployeeInput {
  id: string
  name: string
  payType: 'monthly' | 'daily'
  monthlyRate: number
  dailyRate: number
  isMinimumWageEarner: boolean
  schedule: WorkSchedule
  allowances: AllowanceInput[]
  extraDeductions: ExtraDeductionInput[]
  /** One-time earnings for this run (payroll adjustments). */
  oneTimeEarnings?: OneTimeEarningInput[]
  /** Employment dates: days outside them are no one's missing time (warnings only; pay is unchanged). */
  hireDate?: string
  separationDate?: string | null
}

export interface AllowanceInput {
  label: string
  amount: number
  category: AllowanceCategory
  basis: AllowanceBasis
}

export interface OneTimeEarningInput {
  id?: string
  label: string
  amount: number
  category: BirBucket
}

export interface ExtraDeductionInput {
  id?: string
  label: string
  /** Recurring-deduction category; 'union_dues' is excluded from taxable income. */
  category: string
  amount: number
  /** One-time payroll adjustment rather than a recurring deduction. */
  oneTime?: boolean
}

export interface PayrollSettingsInput {
  standardHoursPerDay: number
  /** DOLE conversion factor: days per year deemed paid (365 / 313 / 261...). */
  workingDaysDivisor: number
  gracePeriodMinutes: number
  nightDiffRate: number
  contributionTiming: ContributionTiming
  payFrequency: PayFrequency
  minimumWageDaily: number
}

export interface PeriodInput {
  start: string
  end: string
  /** 1-based position of this payroll among the pay periods of its payroll month. */
  index: number
  /** Pay periods of this frequency in the payroll month: monthly 1, semi-monthly 2, weekly 4–5. */
  count: number
}

export interface RoundingInput {
  mode: RoundingMode
  /** Centavos carried from the employee's previous payroll (carry_forward). */
  carryIn: number
  /** Final payroll for the employee: pay out everything, never carry. */
  settle?: boolean
}

export interface PayLine {
  code: string
  label: string
  amount: number
  /** Earnings only: whether the line is subject to withholding tax. */
  taxable?: boolean
  /** Earnings only: BIR 2316 / alphalist classification. */
  bir?: BirBucket
  hours?: number
  meta?: string
}

export interface SssComputation {
  msc: number
  ee: number
  er: number
  ecEr: number
  mpfEe: number
  mpfEr: number
}

export interface StatutoryComputation {
  monthlyBase: number
  sss: SssComputation
  philhealthEe: number
  philhealthEr: number
  pagibigEe: number
  pagibigEr: number
  /** Fraction of the monthly contribution charged to this period (0, 1/count or 1). */
  periodFactor: number
}

export interface PayslipComputation {
  employeeId: string
  runType: RunType
  daysWorked: number
  hoursWorked: number
  overtimeHours: number
  nightDiffHours: number
  lateMinutes: number
  undertimeMinutes: number
  absentDays: number
  earnings: PayLine[]
  deductions: PayLine[]
  basicPay: number
  grossPay: number
  taxableIncome: number
  sssEe: number
  sssEr: number
  sssEcEr: number
  sssMpfEe: number
  sssMpfEr: number
  philhealthEe: number
  philhealthEr: number
  pagibigEe: number
  pagibigEr: number
  withholdingTax: number
  unionDues: number
  otherDeductionsTotal: number
  totalDeductions: number
  /** Amount actually paid: gross − deductions + roundingAdjustment. */
  netPay: number
  roundingAdjustment: number
  roundingCarryIn: number
  roundingCarryOut: number
  trace: {
    dailyRate: number
    hourlyRate: number
    statutoryMonthlyBase: number
    notes: string[]
    warnings: string[]
    days: DayComputation[]
  }
}

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
