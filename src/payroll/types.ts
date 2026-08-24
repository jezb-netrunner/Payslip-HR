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

export type PayFrequency = 'semi_monthly' | 'monthly'
export type PeriodHalf = 'first' | 'second' | 'full'
export type ContributionTiming = 'split' | 'first_half' | 'second_half'
export type RunType = 'regular' | 'thirteenth_month' | 'special' | 'final_pay'

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
}

export interface AllowanceInput {
  label: string
  monthlyAmount: number
  taxable: boolean
  deMinimis: boolean
}

export interface ExtraDeductionInput {
  id?: string
  label: string
  category: string
  amount: number
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
  half: PeriodHalf
}

export interface PayLine {
  code: string
  label: string
  amount: number
  /** Earnings only: whether the line is subject to withholding tax. */
  taxable?: boolean
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
  /** Fraction of monthly contribution charged to this period (0, 0.5 or 1). */
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
  otherDeductionsTotal: number
  totalDeductions: number
  netPay: number
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
