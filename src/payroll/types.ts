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

/** De minimis benefit items of RR 2-98 Sec. 2.78.1(A)(3); (b) is for government employees only. */
export type DeMinimisItem = 'a' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k'

export interface DeMinimisCeiling {
  item: DeMinimisItem
  label: string
  /**
   * What the ceiling measures: days of unused vacation leave a year, pesos a
   * month / semester / year, or a share of the employee's regional basic
   * minimum wage (the meal allowance for overtime and night shifts).
   */
  unit: 'days_per_year' | 'per_month' | 'per_semester' | 'per_year' | 'share_of_regional_minimum_wage'
  limit: number
  /** Item (c): the same ceiling stated per month. */
  per_month?: number
}

export interface DeMinimisData {
  items: DeMinimisCeiling[]
}

export interface StatutoryTables {
  sss: SssTableData
  philhealth: PhilHealthData
  pagibig: PagibigData
  bir_wht: BirWhtData
  bir_annual: BirAnnualData
  /** De minimis ceilings in force on the pay date; none on file before 2026-01-07. */
  de_minimis?: DeMinimisData
  /** When those ceilings took effect: pay dated earlier used other ceilings. */
  de_minimis_from?: string
}

export type StatutoryKind = 'sss' | 'philhealth' | 'pagibig' | 'bir_wht' | 'bir_annual' | 'de_minimis'

/** One `statutory_versions` row, as far as picking the tables in force needs it. */
export interface StatutoryVersionRow {
  kind: StatutoryKind
  effective_from: string
  data: unknown
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

/**
 * Regular compensation (R: basic salary and fixed allowances paid each
 * period) or supplementary compensation (S: everything paid in addition to
 * it), RR 2-98 Sec. 2.78.1(A), as amended by RR 11-2018.
 */
export type IncomeClass = 'regular' | 'supplementary'

/**
 * How a pay code's line is taxed (it follows the BIR bucket): always taxable,
 * exempt for minimum wage earners only, in the ₱90k bucket, de minimis, or
 * never taxable.
 */
export type PayCodeTaxTreatment = 'taxable' | 'mwe_exempt' | 'benefits' | 'de_minimis' | 'exempt'

/** One `pay_codes` row: what an allowance or one-time earning is (spec T2, T3). */
export interface PayCode {
  code: string
  label: string
  description: string
  /** offered for recurring allowances */
  for_allowances: boolean
  /** offered for one-time earnings in a payroll (neither: a code the payroll itself uses, like THIRTEENTH_MONTH) */
  for_one_time: boolean
  bir_bucket: BirBucket
  /** R or S of the taxable part when paid as an allowance each period (null: never taxable) */
  income_class: IncomeClass | null
  tax_treatment: PayCodeTaxTreatment
  /** whether it is taxable is a setting until the law is confirmed (spec P1) */
  tax_pending: boolean
  /** counts toward the 13th month besides basic pay (PD 851) */
  include_in_13th_month_base: boolean
  /** include_in_13th_month_base is a setting until the law is confirmed (spec P9) */
  thirteenth_pending: boolean
  /** the maternity benefit the code pays */
  benefit: MaternityBenefit | null
  /** the de minimis item whose ceiling applies (RR 29-2025; spec T7) */
  de_minimis_item: DeMinimisItem | null
  /** in the SSS compensation base (RA 11199 Sec. 8(f), SSS IRR Rule 12 Sec. 6) */
  sss_include: boolean
  /** sss_include is a setting until the law is confirmed (spec P2, P3) */
  sss_include_pending: boolean
  /** the Christmas bonus: out of the SSS base */
  is_christmas_bonus: boolean
  /** a business expense the employee paid and liquidates with receipts: not compensation */
  subject_to_liquidation: boolean
  /** a fringe benefit when given to a managerial or supervisory employee (fringe benefit tax, not withheld on) */
  fringe_benefit: boolean
  sort_order: number
  active: boolean
}

/**
 * A client's leave policy (spec T7): paid vacation leave of at least 5 days
 * in place of the service incentive leave, or SIL only (Labor Code Art. 95).
 * It decides how cash conversion of unused leave is taxed.
 */
export type LeavePolicy = 'vl_in_place_of_sil' | 'sil_only'

/** How a payslip's withholding tax was computed. */
export type WhtMethod = 'regular' | 'cam' | 'annualized'

/**
 * Rules the law hasn't settled, set by company admins for every client
 * (payroll tax rules spec, PENDING items). The defaults keep today's rules.
 */
export interface PayrollRules {
  /**
   * P4: PhilHealth and Pag-IBIG during maternity leave — as usual, or none
   * on a payroll whose scheduled days are all maternity leave.
   */
  maternityContributions: 'as_usual' | 'pause_full_leave'
  /** P5: what Pag-IBIG's monthly compensation is made of. */
  pagibigBase: { basic: boolean; cola: boolean; otherAllowances: boolean }
  /** P5: the ceiling of Pag-IBIG's monthly compensation; null = the statutory table's maximum fund salary. */
  pagibigCeiling: number | null
  /**
   * The apprentice rule (owner 2026-10-25, PENDING: no text yet): an
   * apprentice or learner paid below the minimum wage (75% of it or more) is
   * a minimum wage earner. On by default.
   */
  apprenticeMwe: boolean
}

export interface PayrollEmployeeInput {
  id: string
  name: string
  payType: 'monthly' | 'daily'
  monthlyRate: number
  dailyRate: number
  isMinimumWageEarner: boolean
  /** Apprentice or learner: the wage floor is 75% of the minimum (Labor Code Arts. 61 and 73). */
  apprentice?: boolean
  /** Managerial or supervisory staff: their fringe benefits are subject to the fringe benefit tax, not withheld on. */
  managerial?: boolean
  /**
   * The national government pays the PhilHealth employee share for this
   * period: employed PWDs (RA 11228) and solo parents (RA 11861, PhilHealth
   * Circular 2026-0015). The employer share is unchanged.
   */
  philhealthEeWaiver?: 'pwd' | 'solo_parent'
  schedule: WorkSchedule
  allowances: AllowanceInput[]
  extraDeductions: ExtraDeductionInput[]
  /** One-time earnings for this run (payroll adjustments). */
  oneTimeEarnings?: OneTimeEarningInput[]
  /**
   * A minimum wage earner's hazard pay is exempt only when the hazard pay
   * criteria are met and a DOLE certification is on file (spec T5).
   */
  hazardExempt?: boolean
  /** Employment dates: days outside them are no one's missing time (warnings only; pay is unchanged). */
  hireDate?: string
  separationDate?: string | null
}

export interface AllowanceInput {
  label: string
  amount: number
  category: AllowanceCategory
  basis: AllowanceBasis
  /** its pay code (omitted: the category's code, for rows saved before pay codes) */
  payCode?: string
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
  /** its pay code (omitted: the category's code, for rows saved before pay codes) */
  payCode?: string
  /** leave cash conversion: the days converted */
  days?: number
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
  /** The statutory minimum wage in force for the period (spec T12: the minimum wage table, else the client's setting). */
  minimumWageDaily: number
  /** Where that rate comes from, for messages: "NCR, NCR-26" or "the client's own setting". */
  minimumWageSource?: string
  /** An unworked regular holiday after an unpaid absence: the workday-before rule, or pay it anyway (client setting, spec T12). */
  holidayPayAfterAbsence?: 'apply_rule' | 'pay_anyway'
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
  /** Earnings only: counts toward 13th month pay although not basic pay (the maternity salary differential). */
  thirteenthBasis?: boolean
  /** Allowances and one-time earnings: the pay code. */
  payCode?: string
  /** Earnings only: in the SSS compensation base (spec T3; payslips from before it have no flag). */
  sss?: boolean
  /** Taxable earnings only: regular (R) or supplementary (S) compensation (payslips from before spec T5 have none). */
  incomeClass?: IncomeClass
  /** Leave cash conversion: the days this line pays. */
  days?: number
  /** A fringe benefit to a managerial or supervisory employee: for FBT review, not withheld on, not compensation. */
  fbt?: boolean
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
  /** Taxable compensation: taxableRegular + taxableSupplementary. */
  taxableIncome: number
  /** R: taxable regular compensation, after the contributions and union dues. */
  taxableRegular: number
  /** S: taxable supplementary compensation, the ₱90k excess included. */
  taxableSupplementary: number
  whtMethod: WhtMethod
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
  /**
   * Year-end adjustment: the part of the year's tax shortfall the pay
   * couldn't cover, paid by the employer (an advance to the employee).
   */
  taxPaidByEmployer: number
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
    /** Problems that block finalizing the run until fixed. */
    errors: string[]
    days: DayComputation[]
  }
}

export function round2(v: number): number {
  // + 0: a tiny negative rounds to 0, not -0 (which prints as "-0")
  return Math.round((v + Number.EPSILON) * 100) / 100 + 0
}
