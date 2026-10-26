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

/** The de minimis benefits (RR 2-98 Sec. 2.78.1(A)(3) as amended): the list is exclusive. */
export type DeMinimisKind =
  | 'monetized_vl'
  | 'medical_dependents'
  | 'rice'
  | 'uniform'
  | 'medical_assistance'
  | 'laundry'
  | 'achievement_award'
  | 'christmas_gift'
  | 'meal_ot'
  | 'cba_productivity'

export interface DeMinimisCeiling {
  /** pesos, or days (monetized leave), or a share of the regional minimum wage (overtime meals) */
  limit: number
  per: 'month' | 'semester' | 'year' | 'days_year' | 'ot_day_of_minimum_wage'
}

/** De minimis ceilings in force (legal_parameters 'de_minimis'). */
export interface DeMinimisData {
  ceilings: Record<DeMinimisKind, DeMinimisCeiling>
}

export interface StatutoryTables {
  sss: SssTableData
  philhealth: PhilHealthData
  pagibig: PagibigData
  bir_wht: BirWhtData
  bir_annual: BirAnnualData
  /** by pay date; missing = no ceilings in force (de minimis benefits are then taxable) */
  de_minimis?: DeMinimisData
}

// ---------- attendance ----------

/** An employee's base schedule (employees.work_schedule): one shift on the listed weekdays. */
export interface WorkSchedule {
  /** ISO weekdays that are working days (1=Mon .. 7=Sun). */
  days: number[]
  /** "HH:MM" shift start. */
  start: string
  /** "HH:MM" shift end. */
  end: string
  break_minutes: number
}

/** A scheduled stretch of work on a date (a shift template's or roster entry's snapshot). */
export interface Shift {
  /** "HH:MM" start; an end at or before the start is the next morning */
  start: string
  end: string
  /** unpaid meal break, deducted from a day of 6 hours or more */
  break_minutes: number
  /** flexible start: a time in up to this many minutes after `start` is on time, and the shift moves with it */
  flex_minutes?: number
  /** compressed workweek: the whole shift is regular time, so overtime starts only after it */
  compressed?: boolean
  /** the template it was taken from, for display */
  name?: string
}

/** Monday..Sunday (index 0 = Monday); null = rest day. */
export type WeekPattern = (Shift | null)[]

/** What the schedule says for one date. */
export interface DaySchedule {
  /** null = rest day */
  shift: Shift | null
  /** unpaid break for a day worked without a shift (rest-day work) */
  restDayBreakMinutes: number
}

/** The schedule in force on each date (base schedule, effective-dated patterns, roster changes). */
export type ScheduleResolver = (date: string) => DaySchedule

/** A fixed weekly schedule, or one resolved per date. */
export type ScheduleSource = WorkSchedule | ScheduleResolver

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
  /** the leave type's code (ML = maternity leave, paid through the maternity benefit) */
  type_code?: string
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
  /** Worked minutes credited as regular time (within the standard day, or a longer compressed shift). */
  payableMinutes: number
  /** Regular minutes the date's shift expects (0 on a rest day); missing ones are tardiness, undertime or absence. */
  expectedMinutes?: number
  /** The shift scheduled that date (null = rest day). */
  shift?: Shift | null
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
  /** the leave type's code, on a leave day not worked */
  leaveCode?: string
  /** the first day of that leave */
  leaveStart?: string
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
  | 'holiday' //           holiday, special-day and rest-day premium pay (an MWE's: holiday pay only)
  | 'premium' //           an MWE's rest-day and special-day premiums: taxable (2316 item 51)
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
  | 'other_supplementary' // other taxable supplementary pay: pay above a de minimis ceiling, leave converted to cash (2316 item 51)
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

/**
 * Pay-item types that are not SSS compensation (RA 11199 Sec. 8(f)): a
 * bonus typed as the Christmas bonus, and an allowance subject to
 * liquidation (a reimbursement).
 */
export type PayItemType = 'christmas_bonus' | 'liquidated_allowance'

/** monthly: split over the month's pay periods; per_period: every payroll; per_day: per paid day. */
export type AllowanceBasis = 'monthly' | 'per_period' | 'per_day'

export interface PayrollEmployeeInput {
  id: string
  name: string
  payType: 'monthly' | 'daily'
  monthlyRate: number
  dailyRate: number
  isMinimumWageEarner: boolean
  /** Apprentice or learner: the wage floor is 75% of the minimum (Labor Code Arts. 61 and 73). */
  apprentice?: boolean
  /**
   * The national government pays the PhilHealth employee half this payroll
   * month (solo parents, PWDs — PhilHealth Circulars 2026-0015, 2026-0017):
   * nothing is deducted, the employer pays its usual half, and the NG half
   * is shown, neither deducted nor remitted.
   */
  philhealthNg?: 'pwd' | 'solo_parent'
  schedule: WorkSchedule
  allowances: AllowanceInput[]
  extraDeductions: ExtraDeductionInput[]
  /** One-time earnings for this run (payroll adjustments). */
  oneTimeEarnings?: OneTimeEarningInput[]
  /**
   * DOLE or allied agency certification of an actual assignment to a
   * hazardous area or station: without it, an MWE's hazard pay is taxable.
   */
  hazardCertificationRef?: string
  /** Employment dates: days outside them are no one's missing time (warnings only; pay is unchanged). */
  hireDate?: string
  separationDate?: string | null
}

export interface AllowanceInput {
  label: string
  amount: number
  category: AllowanceCategory
  basis: AllowanceBasis
  /** which de minimis benefit (category de_minimis): none = not on the list, taxable */
  deMinimisKind?: DeMinimisKind
  payItemType?: PayItemType
}

/**
 * RA 11210 maternity pay, paid as its own earnings (both tax-exempt, RMC
 * 105-2019): the SSS maternity benefit the employer advances, and the
 * salary differential up to full pay, which counts toward the 13th month.
 */
export type MaternityBenefit = 'sss_maternity' | 'maternity_differential'

export interface OneTimeEarningInput {
  id?: string
  label: string
  amount: number
  category: BirBucket
  benefit?: MaternityBenefit
  /** which de minimis benefit (category de_minimis) */
  deMinimisKind?: DeMinimisKind
  /** unused leave converted to cash: the days converted */
  leaveDays?: number
  payItemType?: PayItemType
}

export interface ExtraDeductionInput {
  id?: string
  label: string
  /** Recurring-deduction category; 'union_dues' is excluded from taxable income. */
  category: string
  amount: number
  /** One-time payroll adjustment rather than a recurring deduction. */
  oneTime?: boolean
  /**
   * Cash advances: deducted last, after tax, and only as far as net pay
   * allows — what can't be taken stays owed for the next payroll.
   */
  upToNet?: boolean
  /** Balance owed before this payroll: the payslip line then says what is left. */
  balance?: number
  /** The whole balance is due now (the employee's separation). */
  settlement?: boolean
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
  /** An MWE's extra 30% for a regular holiday worked on the rest day is taxable (client setting, default true). */
  mweRhRestdayPremiumTaxable?: boolean
  /** Paid vacation leave days the client grants a year (5 or more: outside SIL, Labor Code Art. 95(b)). */
  paidVlDaysPerYear?: number
  /** A SIL-only client's leave converted to cash is taxable (default true, O7). */
  silConversionTaxable?: boolean
  /** The 13th month pay is SSS compensation of its month (client setting, default true, O2). */
  sssInclude13thMonth?: boolean
  /** The client's DOLE exemption from the maternity salary differential, when it claims one. */
  maternityDifferentialExemption?: { ref: string; validUntil: string }
  /**
   * No regular holiday pay after unpaid absence on the workday before a
   * holiday not worked (client setting, default off: the holiday is paid, O8).
   */
  holidayAbsenceRule?: boolean
  /** A retail or service establishment regularly employing less than 10 workers: no holiday pay (Labor Code Art. 94). */
  holidayPayExempt?: boolean
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
  /** Earnings only: the de minimis benefit the line is (its ceiling applies). */
  dm?: DeMinimisKind
  /** Earnings only: days of leave converted to cash this line pays. */
  leaveDays?: number
  /** Earnings only: false = not SSS compensation (Christmas bonus, allowance subject to liquidation, maternity pay). */
  sss?: boolean
  /** Deductions only: the maternity leave months a payout's contribution deduction covers. */
  covers?: { month: string; amount: number }[]
  /**
   * Earnings only: true counts toward 13th month pay although not basic pay
   * (the maternity salary differential); false leaves basic pay out of it
   * (an MWE's rest-day wage, paid on top of the monthly rate).
   */
  thirteenthBasis?: boolean
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

/** How a payslip's withholding tax was computed. */
export interface TaxTrace {
  method: 'table' | 'supplementary' | 'cumulative_average' | 'annualized'
  /** taxable regular and supplementary pay of the payroll */
  regular: number
  supplementary: number
  /** cumulative average method: the year's taxable pay, its average a period, and the periods */
  cumulative?: number
  average?: number
  periods?: number
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
  /** PhilHealth's employee half paid by the national government: not deducted, not remitted */
  philhealthNg: number
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
    tax?: TaxTrace
  }
}

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
