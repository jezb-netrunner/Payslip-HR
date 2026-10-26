// The payroll engine: turns attendance facts + statutory tables + employee
// pay data into a full payslip computation with an auditable trace.
//
// Legal basis implemented here (PH private sector):
//  - Labor Code premium pay: rest day/special day 130%, special+rest 150%,
//    regular holiday 200%, regular holiday+rest 260%; OT +25% ordinary days,
//    +30% of the day rate on rest days/special days/holidays; night shift
//    differential +10% (10pm–6am).
//  - SSS (RA 11199), PhilHealth (RA 11223), Pag-IBIG (RA 9679) from the
//    versioned tables passed in; monthly amounts are allocated over the
//    weekly / semi-monthly / monthly pay periods of the payroll month.
//  - Withholding tax on compensation: BIR revised tables (TRAIN, RR 11-2018
//    as amended) for the employee's pay frequency; annual graduated table
//    when the payroll annualizes (year-end or separation). Union dues and
//    mandatory contributions are excluded from taxable compensation; the
//    statutory minimum wage package of MWEs is exempt.
//  - 13th month pay (PD 851): 1/12 of basic salary earned in the calendar
//    year (installments supported); tax-exempt together with other benefits
//    up to the statutory cap.

import { annualizedWithholding, isTaxableBucket, type AnnualPayslipFact, type PriorEmployerInput } from './annual'
import { bracketOf, computePagibig, computePhilHealth, computeSss } from './statutory'
import { EMPLOYMENT, HOLIDAY_PAY, LEAVE, OVERTIME, PREMIUM } from './law'
import { periodWithholding, REGULAR_COMPENSATION_BUCKETS, type PeriodTax, type TaxYearToDate } from './withholding'
import {
  round2,
  type BirBucket,
  type ContributionTiming,
  type DayComputation,
  type DayType,
  type DeMinimisKind,
  type PayItemType,
  type PayLine,
  type PayrollEmployeeInput,
  type PayrollSettingsInput,
  type PayslipComputation,
  type PeriodInput,
  type RoundingInput,
  type RunType,
  type SssComputation,
  type StatutoryComputation,
  type StatutoryTables,
  type TaxTrace,
} from './types'

/**
 * A worked day's pay above its 100%: a regular holiday's extra 100% and the
 * premium on top (rest day, special day, a regular holiday on the rest day).
 */
export const DAY_PARTS: Record<DayType, { holiday: number; premium: number }> = {
  regular: { holiday: 0, premium: 0 },
  rest_day: { holiday: 0, premium: PREMIUM.restDay.value },
  special_day: { holiday: 0, premium: PREMIUM.specialDay.value },
  special_day_rest: { holiday: 0, premium: PREMIUM.specialDayOnRestDay.value },
  regular_holiday: { holiday: PREMIUM.regularHoliday.value, premium: 0 },
  regular_holiday_rest: {
    holiday: PREMIUM.regularHoliday.value,
    premium: PREMIUM.regularHolidayOnRestDay.value * (1 + PREMIUM.regularHoliday.value),
  },
}

/** Day multipliers: rest/special day 130%, special+rest 150%, regular holiday 200%, holiday+rest 260%. */
export const DAY_MULT = Object.fromEntries(
  Object.entries(DAY_PARTS).map(([t, p]) => [t, 1 + p.holiday + p.premium]),
) as Record<DayType, number>

/**
 * Portion of the day multiplier already covered by the monthly rate for
 * monthly-paid employees. Divisor-261/313 style factors treat scheduled
 * days, regular holidays and special days as paid whether or not worked,
 * but NOT rest days; a 365 divisor deems every calendar day (rest days
 * included) paid inside the monthly rate — so rest-day coverage depends on
 * the configured divisor (see builtInFor below).
 */
const BUILT_IN_MULT: Record<DayType, number> = {
  regular: 1,
  rest_day: 0,
  special_day: 1,
  special_day_rest: 0,
  regular_holiday: 1,
  regular_holiday_rest: 0,
}

function builtInFor(dayType: DayType, workingDaysDivisor: number): number {
  const base = BUILT_IN_MULT[dayType]
  if (base > 0) return base
  // Divisor 365: rest days are already paid inside the monthly rate.
  return workingDaysDivisor >= 365 ? 1 : 0
}

/**
 * Whether a day of unpaid leave costs pay: for monthly-paid, every day the
 * monthly rate covers (regular days, holidays, and rest days under divisor
 * 365); for daily-paid, ordinary workdays (no work is already no pay).
 */
export function unpaidLeaveCharged(dayType: DayType, payType: 'monthly' | 'daily', workingDaysDivisor: number): boolean {
  return payType === 'monthly' ? builtInFor(dayType, workingDaysDivisor) > 0 : dayType === 'regular'
}

/**
 * The maternity leave type's code. RA 11210's 105 days of full pay are the
 * SSS maternity benefit the employer advances plus any salary differential,
 * paid as their own earnings — not as salary for the leave days.
 */
export const MATERNITY_LEAVE_CODE = 'ML'

function isRegularHolidayType(dayType: DayType): boolean {
  return dayType === 'regular_holiday' || dayType === 'regular_holiday_rest'
}

/**
 * Which unworked regular holidays are paid. The employee must have worked,
 * or been on paid leave, on the workday immediately before the holiday: a
 * rest day or non-working (special) day in between is passed over, and an
 * earlier holiday in between counts when it was itself worked or paid —
 * Holy Thursday and Good Friday (IRR Book III, Rule IV, Secs. 6 and 10).
 * With no workday on record before it (not yet hired, or beyond the days
 * given) the holiday is paid. `timeline` is in date order.
 */
export function unworkedHolidaysPaid(
  timeline: DayComputation[],
  employed: (date: string) => boolean,
): Map<string, boolean> {
  const paid = new Map<string, boolean>()
  let attended: boolean | null = null
  for (const d of timeline) {
    const worked = d.workedMinutes > 0
    if (!employed(d.date)) attended = null
    else if (isRegularHolidayType(d.dayType)) {
      if (worked) attended = true
      else {
        const ok: boolean = attended !== false
        paid.set(d.date, ok)
        attended = ok
      }
    } else if (d.dayType === 'regular') attended = worked || d.onPaidLeave || d.leaveCode === MATERNITY_LEAVE_CODE
    else if (worked) attended = true
  }
  return paid
}

function otMultiplier(dayType: DayType): number {
  return dayType === 'regular' ? 1 + OVERTIME.ordinaryDay.value : DAY_MULT[dayType] * (1 + OVERTIME.premiumDay.value)
}

export interface AnnualizationInput {
  /** Month this payroll is paid (YYYY-MM-01). */
  payMonth: string
  /** This employer's finalized payslips paid earlier in the same calendar year. */
  ytd: AnnualPayslipFact[]
  prior?: PriorEmployerInput
  peraCredit?: number
}

/** Statutory contributions, employee and employer shares. */
export interface ContributionSet {
  sssEe: number
  sssMpfEe: number
  philhealthEe: number
  pagibigEe: number
  sssEr: number
  sssMpfEr: number
  sssEcEr: number
  philhealthEr: number
  pagibigEr: number
  /** PhilHealth's employee half the national government paid (not deducted) */
  philhealthNg?: number
}

/**
 * Where this payroll sits in the employee's own month. Slot-based shares
 * assume the employee is on every payroll of the month; a hire or
 * separation mid-month breaks that, so the month is completed explicitly.
 */
export interface MonthContributionsInput {
  /** Already deducted this payroll month in the employee's finalized payslips. */
  already: ContributionSet
  /**
   * SSS compensation those payslips paid (sssCompensation of their
   * earnings): with it, the month's closing payroll settles SSS on the
   * month's actual compensation. Omitted = SSS on the rate.
   */
  compensationAlready?: number
  /** The employee's last payroll of the month (last slot or separation): deduct what the month still owes. */
  closes: boolean
  /** First payroll of the month for the employee: under 'first_period' timing the month is deducted here. */
  opens: boolean
}

export interface ComputePayslipParams {
  employee: PayrollEmployeeInput
  settings: PayrollSettingsInput
  period: PeriodInput
  tables: StatutoryTables
  days: DayComputation[]
  runType: RunType
  /** Cash net-pay rounding for this employee (omitted = exact centavos). */
  rounding?: RoundingInput
  /** Annualize withholding in this payroll (last payroll of the year / separation). */
  annualization?: AnnualizationInput
  /**
   * Final pay released after the employee's last paid period: only the
   * one-time items, the tax adjustment and the rounding settlement — no
   * attendance pay, allowances or contributions (there is no work left to pay).
   */
  extrasOnly?: boolean
  /** Completes the month's contributions around hires and separations (omitted = plain slot shares). */
  monthContributions?: MonthContributionsInput
  /**
   * Attendance of the days just before the period (a week or so), for the
   * workday before a regular holiday early in the period.
   */
  daysBefore?: DayComputation[]
  /** 13th month: basic pay earned so far this calendar year. */
  ytdBasicPay?: number
  /** 13th month: other benefits (bonuses) already paid this year. */
  ytdOtherBenefits?: number
  /** 13th month: 13th month pay already paid this year (installments). */
  ytdThirteenthPaid?: number
  /** 13th month: 13th month/other benefits a previous employer already exempted this year. */
  priorThirteenthOtherBenefitsExempt?: number
  /**
   * 13th month: 13th month pay and other benefits already PAID in the tax
   * year of this payroll's pay date — the exemption cap is per tax year,
   * which differs from the payroll year when the pay is released in January.
   * Omitted = the payroll-year installments and other benefits.
   */
  taxYearBenefitsPaid?: number
  /**
   * Regular payrolls: what is left of the tax year's exemption for 13th month
   * pay and other benefits — the cap less what a previous employer exempted
   * and what was already paid in the tax year. Omitted = the whole cap.
   */
  benefitsExemptLeft?: number
  /**
   * Extras-only final pay: the separation month's contributions already
   * deducted, to flag a month the last payroll never completed (the
   * separation was recorded after that payroll was finalized).
   */
  separationMonth?: { label: string; already: ContributionSet; compensation?: number }
  /** The tax year so far (cumulative average method); omitted = no history. */
  taxYear?: TaxYearToDate
  /**
   * De minimis benefits earlier payrolls already paid, per benefit: this
   * pay month, half-year and tax year (pesos; days for monetized leave).
   */
  deMinimisUsed?: Partial<Record<DeMinimisKind, DeMinimisUsed>>
  /** The employee's maternity leave this payroll's month falls in or pays for. */
  maternity?: MaternityContext
}

/** One month a maternity leave touches, from the employee's finalized payslips. */
export interface MaternityMonth {
  /** YYYY-MM-01 */
  month: string
  /** employee contributions the month's payslips charged */
  charged: number
  /** the part of them the month's own pay covered */
  fundedByPay: number
  /** prepaid shares the month's payslips already used */
  prepaidUsed: number
  /** shares maternity payouts took for the month */
  covered: number
}

/** The maternity leave around this payroll (RA 11210). */
export interface MaternityContext {
  leaveStart: string
  months: MaternityMonth[]
  /** this payroll's month (YYYY-MM-01) */
  thisMonth: string
}

export interface DeMinimisUsed {
  month: number
  semester: number
  year: number
  /** this payroll (computed here) */
  payroll?: number
}

/**
 * SSS compensation of a month: all actual remuneration for employment,
 * mandated COLA included — pay for work and leave, holiday pay, overtime,
 * premiums, night differential, hazard pay, commissions, bonuses,
 * allowances (taxable or de minimis), leave converted to cash and the 13th
 * month pay (client setting, default on) — except a pay item typed as the
 * Christmas bonus and an allowance subject to liquidation. Maternity pay is
 * left out: the leave months contribute at the usual amounts.
 * Basis: RA 11199 Secs. 8(f), 8(h), 18, 19(a); IRR of RA 11199 Rule 12 Secs. 6, 8.
 */
export function sssCompensation(
  lines: readonly Pick<PayLine, 'amount' | 'bir' | 'sss'>[],
  opts: { sssInclude13thMonth?: boolean } = {},
): number {
  return round2(
    lines
      .filter((l) => l.sss !== false && (l.bir !== 'thirteenth' || opts.sssInclude13thMonth !== false))
      .reduce((s, l) => s + Number(l.amount), 0),
  )
}

const NO_SSS: SssComputation = { msc: 0, ee: 0, er: 0, ecEr: 0, mpfEe: 0, mpfEr: 0 }

export function deriveRates(
  employee: PayrollEmployeeInput,
  settings: PayrollSettingsInput,
): { daily: number; hourly: number; statutoryMonthlyBase: number } {
  const daily =
    employee.payType === 'monthly'
      ? (employee.monthlyRate * 12) / settings.workingDaysDivisor
      : employee.dailyRate
  const hourly = daily / settings.standardHoursPerDay
  const statutoryMonthlyBase =
    employee.payType === 'monthly'
      ? employee.monthlyRate
      : round2((employee.dailyRate * settings.workingDaysDivisor) / 12)
  return { daily, hourly, statutoryMonthlyBase }
}

/**
 * Allocate a monthly amount to pay period `index` of `count` so the periods
 * of the month sum EXACTLY to the monthly amount: every period but the last
 * takes the floored equal share, the last takes the remainder.
 */
export function allocateMonthly(monthlyAmount: number, index: number, count: number): number {
  if (count <= 1) return round2(monthlyAmount)
  const cents = Math.round(monthlyAmount * 100)
  const share = Math.floor(cents / count)
  return index < count ? share / 100 : (cents - share * (count - 1)) / 100
}

/** Fraction of a monthly contribution charged to this pay period. */
export function contributionFactor(timing: ContributionTiming, period: PeriodInput): number {
  if (period.count <= 1) return 1
  if (timing === 'first_period') return period.index === 1 ? 1 : 0
  if (timing === 'last_period') return period.index === period.count ? 1 : 0
  return 1 / period.count
}

/** Monthly contribution amount deducted in this pay period. */
export function contributionShare(
  monthlyAmount: number,
  timing: ContributionTiming,
  period: PeriodInput,
): number {
  const f = contributionFactor(timing, period)
  if (f >= 1) return round2(monthlyAmount)
  if (f <= 0) return 0
  return allocateMonthly(monthlyAmount, period.index, period.count)
}

export function computeStatutory(
  statutoryMonthlyBase: number,
  settings: PayrollSettingsInput,
  period: PeriodInput,
  tables: StatutoryTables,
  /** Pag-IBIG's monthly compensation: basic salary plus allowances (default: the basic) */
  pagibigBase = statutoryMonthlyBase,
): StatutoryComputation {
  const sss = computeSss(statutoryMonthlyBase, tables.sss)
  const ph = computePhilHealth(statutoryMonthlyBase, tables.philhealth)
  const pi = computePagibig(pagibigBase, tables.pagibig)

  return {
    monthlyBase: statutoryMonthlyBase,
    sss,
    philhealthEe: ph.ee,
    philhealthEr: ph.er,
    pagibigEe: pi.ee,
    pagibigEr: pi.er,
    periodFactor: contributionFactor(settings.contributionTiming, period),
  }
}

/**
 * Cash rounding of net pay. Works in integer centavos. A negative net pay
 * is never rounded (it needs review, not cash).
 */
export function applyNetPayRounding(
  netExact: number,
  rounding: RoundingInput | undefined,
): { paid: number; adjustment: number; carryIn: number; carryOut: number } {
  const carryIn = rounding ? round2(rounding.carryIn) : 0
  const availCents = Math.round((netExact + carryIn) * 100)
  let paidCents = availCents
  let carryOutCents = 0
  if (rounding && availCents > 0) {
    const roundUp = rounding.mode === 'round_up' || (rounding.mode === 'carry_forward' && rounding.settle)
    if (roundUp) {
      paidCents = Math.ceil(availCents / 100) * 100
    } else if (rounding.mode === 'carry_forward') {
      paidCents = Math.floor(availCents / 100) * 100
      carryOutCents = availCents - paidCents
    }
  }
  const paid = paidCents / 100
  return {
    paid,
    adjustment: round2(paid - netExact),
    carryIn,
    carryOut: carryOutCents / 100,
  }
}

/**
 * The year-end (or separation) shortfall is withheld from this pay only as
 * far as it goes: net pay reaches zero, never below. The employer pays the
 * rest — remitted with the month's 1601-C, shown as withheld on the 2316 —
 * and collects it from the employee as an advance. A refund is never capped.
 * Basis: NIRC Secs. 79(F), 83(A); RR 2-98 Sec. 2.79(B)(5)(b) as amended by
 * RR 11-2018.
 */
export function capShortfall(due: number, available: number): { withheld: number; advanced: number } {
  if (due <= 0) return { withheld: round2(due), advanced: 0 }
  const withheld = round2(Math.min(due, Math.max(0, available)))
  return { withheld, advanced: round2(due - withheld) }
}

const WHT_TABLE: Record<PayrollSettingsInput['payFrequency'], 'weekly' | 'semi_monthly' | 'monthly'> = {
  weekly: 'weekly',
  semi_monthly: 'semi_monthly',
  monthly: 'monthly',
}

const FREQUENCY_LABEL: Record<PayrollSettingsInput['payFrequency'], string> = {
  weekly: 'weekly',
  semi_monthly: 'semi-monthly',
  monthly: 'monthly',
}

/** Why a client can't claim the holiday pay exemption ('' = it can). */
export function holidayPayExemptProblem(c: { retailOrService: boolean; regularWorkers: number | null }): string {
  if (!c.retailOrService) return 'Only a retail or service establishment can be exempt from holiday pay (Labor Code Art. 94).'
  const limit = HOLIDAY_PAY.exemptBelowWorkers.value
  if (c.regularWorkers === null || !(c.regularWorkers < limit)) {
    return `Only an establishment regularly employing less than ${limit} workers is exempt from holiday pay (Labor Code Art. 94).`
  }
  return ''
}

/**
 * A retail or service establishment regularly employing less than 10
 * workers pays no holiday pay (Labor Code Art. 94(a); Omnibus Rules Book
 * III, Rule IV, Sec. 1): its regular holidays are ordinary days (a rest day
 * stays a rest day).
 */
function withoutHolidayPay(d: DayComputation): DayComputation {
  if (d.dayType === 'regular_holiday') return { ...d, dayType: 'regular' }
  if (d.dayType === 'regular_holiday_rest') return { ...d, dayType: 'rest_day' }
  return d
}

export function computePayslip(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, period, tables, runType } = params
  if (runType === 'thirteenth_month') return computeThirteenthMonth(params)
  const extrasOnly = params.extrasOnly === true
  const holidayPayExempt = settings.holidayPayExempt === true
  const days = (extrasOnly ? [] : params.days).map((d) => (holidayPayExempt ? withoutHolidayPay(d) : d))

  const notes: string[] = []
  const warnings: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)
  const perMinute = hourly / 60
  const isMwe = employee.isMinimumWageEarner

  // apprentices and learners may be paid 75% of the minimum (Labor Code Arts. 61 and 73)
  const wageFloor = settings.minimumWageDaily * (employee.apprentice ? EMPLOYMENT.apprenticeShareOfMinimumWage.value : 1)
  if (daily + 0.005 < wageFloor) {
    warnings.push(
      `Derived daily rate ₱${daily.toFixed(2)} is below ${employee.apprentice ? '75% of ' : ''}the configured minimum wage ₱${settings.minimumWageDaily.toFixed(2)}.`,
    )
  }
  // only an employee paid the statutory minimum wage is a minimum wage earner (RR 11-2018)
  if (isMwe && settings.minimumWageDaily > 0 && daily > settings.minimumWageDaily + 0.005) {
    warnings.push(
      `Marked as a minimum wage earner, but the daily rate ₱${daily.toFixed(2)} is above the configured minimum wage ₱${settings.minimumWageDaily.toFixed(2)}: only an employee paid the statutory minimum wage is tax-exempt as one. Update the client's minimum wage if a new wage order took effect, or clear the employee's minimum wage earner setting.`,
    )
  }

  // A scheduled workday without a complete time in/out (an entry with no
  // time out doesn't count) and no approved leave is charged as an absence.
  // That is usually right, but it is also what a day nobody entered looks
  // like (attendance is keyed in by admins): name the dates. Days before the
  // hire or after the separation are absences too, but no one's missing time.
  const employed = (d: string) =>
    (!employee.hireDate || d >= employee.hireDate) && (!employee.separationDate || d <= employee.separationDate)
  const absentDates = days.filter((d) => d.absent && employed(d.date)).map((d) => d.date)
  if (absentDates.length > 0) {
    const shown = absentDates.slice(0, 6).map(shortDate).join(', ') + (absentDates.length > 6 ? ', …' : '')
    warnings.push(
      `${absentDates.length === 1 ? '1 scheduled workday' : `${absentDates.length} scheduled workdays`} without a complete time in/out or approved leave ${absentDates.length === 1 ? 'is' : 'are'} charged as absence (${shown}). If the employee worked, enter the missing time and recompute.`,
    )
  }

  // The holiday absence rule is a client setting, off by default: an unworked
  // regular holiday is then paid after an unpaid absence the workday before
  // too (Labor Code Arts. 94, 100; Omnibus Rules Book III, Rule IV, Sec. 6
  // "may not be paid", open item O8)
  const holidayPaid = settings.holidayAbsenceRule
    ? unworkedHolidaysPaid([...(params.daysBefore ?? []), ...days], employed)
    : new Map<string, boolean>()
  const unpaidHolidays = days.filter((d) => holidayPaid.get(d.date) === false)
  if (unpaidHolidays.length > 0) {
    warnings.push(
      `Regular holiday not paid (${unpaidHolidays.map((d) => `${d.holidayName ?? 'holiday'}, ${shortDate(d.date)}`).join('; ')}): no work or paid leave on the workday before it (IRR Book III, Rule IV, Sec. 6; the client's holiday absence rule). If the employee worked that day, enter the time and recompute.`,
    )
  }
  if (holidayPayExempt && params.days.some((d) => isRegularHolidayType(d.dayType))) {
    notes.push(
      'Regular holidays are paid as ordinary days: a retail or service establishment regularly employing less than 10 workers is exempt from holiday pay (Labor Code Art. 94).',
    )
  }

  // ---- aggregate attendance ----
  let daysWorked = 0
  let hoursWorked = 0
  let otHours = 0
  let ndHours = 0
  let lateMin = 0
  let undertimeMin = 0
  let absentDays = 0
  // days with overtime or night work (the de minimis overtime meal ceiling)
  let overtimeOrNightDays = 0
  let paidLeaveDays = 0
  let unpaidLeaveDays = 0
  // absences and unpaid leave in days' pay: a half-day schedule misses half a day
  let absencePayDays = 0
  let unworkedRegularHolidays = 0
  let paidUnworkedHolidays = 0
  // monthly-paid: regular holidays inside the rate that are not paid
  let unpaidHolidayDays = 0
  // monthly-paid: days before the hire date or after the last day that the
  // rate covers and that aren't docked as absences (holidays, special days)
  let outsideEmploymentDays = 0
  // maternity leave days, and those the monthly rate covers (in days' pay)
  const maternityDates: string[] = []
  let maternityPayDays = 0

  let otPay = 0
  let ndPay = 0
  // monthly-paid: hours past a shorter shift (a half day), up to the standard day
  let extraRegularMinutes = 0
  let restDayPay = 0
  let specialDayPremium = 0
  let holidayPremium = 0
  let dailyBasic = 0 // daily-paid only
  // minimum wage earners: only the minimum wage, holiday pay, overtime,
  // night differential and qualifying hazard pay are exempt; rest-day and
  // special-day premiums are taxable (NIRC Sec. 24(A)(2)(a) last proviso;
  // RR 2-98 Secs. 2.78.1(B)(13) and 2.79(A) as amended by RR 11-2018)
  let mweRestDayWage = 0 // monthly-paid: the 100% of rest-day work the rate doesn't cover
  let mweRestDayPremium = 0
  let mweSpecialPremium = 0
  let mweHolidayRestPremium = 0 // the extra 30% of a regular holiday worked on the rest day

  const stdMin = settings.standardHoursPerDay * 60
  // the share of a standard day the date's shift schedules (1 when there is no shift)
  const dayShare = (d: DayComputation) => (d.scheduled ? (d.expectedMinutes ?? stdMin) / stdMin : 1)

  // an MWE's worked day above its 100%: the regular holiday's extra 100% is
  // exempt holiday pay, the premium on top is taxable — the extra 30% of a
  // regular holiday on the rest day as the client sets it (default taxable)
  const rhRestPremiumTaxable = settings.mweRhRestdayPremiumTaxable !== false
  const mwePremium = (dayType: DayType, dayWage: number) => {
    const p = DAY_PARTS[dayType]
    holidayPremium += p.holiday * dayWage
    if (dayType === 'rest_day') mweRestDayPremium += p.premium * dayWage
    else if (dayType === 'special_day' || dayType === 'special_day_rest') mweSpecialPremium += p.premium * dayWage
    else if (rhRestPremiumTaxable) mweHolidayRestPremium += p.premium * dayWage
    else holidayPremium += p.premium * dayWage
  }

  for (const d of days) {
    const worked = d.workedMinutes > 0
    // regular hours as a share of the standard day; above 1 only on a
    // longer compressed-workweek shift
    const fraction = d.payableMinutes / stdMin
    const builtIn = builtInFor(d.dayType, settings.workingDaysDivisor)
    // maternity leave is paid as the maternity benefit, not as salary (and
    // the benefit runs on every calendar day, holidays included)
    if (!worked && d.leaveCode === MATERNITY_LEAVE_CODE) {
      maternityDates.push(d.date)
      if (employee.payType === 'monthly' && builtIn > 0) maternityPayDays += dayShare(d)
      continue
    }
    if (worked) {
      daysWorked += 1
      if (d.otMinutes > 0 || d.nightDiffMinutes > 0) overtimeOrNightDays += 1
      hoursWorked += d.workedMinutes / 60
      otHours += d.otMinutes / 60
      ndHours += d.nightDiffMinutes / 60
      lateMin += d.lateMinutes
      undertimeMin += d.undertimeMinutes
    }
    if (d.absent) {
      absentDays += 1
      absencePayDays += dayShare(d)
    }
    // Leave flags exist on every covered day. Paid-leave credit applies to
    // ordinary scheduled days. Unpaid leave deducts every day the pay basis
    // would otherwise cover: for monthly-paid, any day the divisor deems
    // paid inside the rate (regular days always; holidays; rest days too
    // under divisor 365); for daily-paid it is a statistic on scheduled days
    // (no work already means no pay).
    if (d.onPaidLeave && d.dayType === 'regular') paidLeaveDays += 1
    // an unworked regular holiday is paid on the workday-before rule, even
    // inside a leave without pay that starts on it — never before the hire
    // date or after the last day
    const employedThen = employed(d.date)
    const holidayOk = employedThen && holidayPaid.get(d.date) !== false
    if (!worked && !employedThen && !d.absent && !d.onUnpaidLeave && employee.payType === 'monthly' && builtIn > 0) {
      outsideEmploymentDays += 1
    }
    if (d.onUnpaidLeave && !worked && !(isRegularHolidayType(d.dayType) && holidayOk)) {
      if (unpaidLeaveCharged(d.dayType, employee.payType, settings.workingDaysDivisor)) {
        unpaidLeaveDays += 1
        absencePayDays += dayShare(d)
      }
    }
    if (!worked && isRegularHolidayType(d.dayType)) {
      unworkedRegularHolidays += 1
      if (holidayOk) paidUnworkedHolidays += 1
    }

    if (employee.payType === 'monthly') {
      if (worked) {
        // The monthly rate pays the shift's own hours; time past a shorter
        // shift up to the standard day is not overtime (Art. 87 starts at 8
        // hours) but is still worked: paid at the regular rate.
        if (d.scheduled && builtIn > 0) {
          extraRegularMinutes += Math.max(0, d.payableMinutes - (d.expectedMinutes ?? stdMin))
        }
        const extraMult = DAY_MULT[d.dayType] - builtIn
        const extra = extraMult * hourly * (d.payableMinutes / 60)
        if (isMwe) {
          const h = hourly * (d.payableMinutes / 60)
          if (builtIn === 0) mweRestDayWage += h
          mwePremium(d.dayType, h)
        } else if (d.dayType === 'rest_day') restDayPay += extra
        else if (d.dayType === 'special_day' || d.dayType === 'special_day_rest')
          specialDayPremium += extra
        else if (isRegularHolidayType(d.dayType)) holidayPremium += extra
      } else if (isRegularHolidayType(d.dayType)) {
        // Paid: a holiday on a day the divisor does NOT deem paid (e.g. a
        // rest day under divisor 261) earns 100% of the daily wage (Art.
        // 94); a covered day is already paid inside the monthly rate. Not
        // paid: a covered day is deducted (on leave without pay over it, the
        // unpaid-leave rule above already did).
        if (holidayOk && builtIn === 0) holidayPremium += daily
        else if (!holidayOk && builtIn > 0 && !d.onUnpaidLeave && employedThen) unpaidHolidayDays += 1
      }
    } else {
      // daily-paid: no work, no pay — each worked day is paid at its multiplier
      if (worked) {
        dailyBasic += 1.0 * daily * fraction
        const premium = (DAY_MULT[d.dayType] - 1) * daily * fraction
        if (isMwe) mwePremium(d.dayType, daily * fraction)
        else if (d.dayType === 'rest_day') restDayPay += premium
        else if (d.dayType === 'special_day' || d.dayType === 'special_day_rest')
          specialDayPremium += premium
        else if (isRegularHolidayType(d.dayType)) holidayPremium += premium
      } else if (isRegularHolidayType(d.dayType)) {
        // Unworked regular holiday: 100% of daily wage (Labor Code Art. 94),
        // whether or not it falls on the rest day, on the workday-before rule
        if (holidayOk) holidayPremium += daily
      }
      if (d.onPaidLeave && d.dayType === 'regular') dailyBasic += daily * dayShare(d)
    }

    if (worked && d.otMinutes > 0) {
      otPay += (d.otMinutes / 60) * hourly * otMultiplier(d.dayType)
    }
    if (worked && d.nightDiffMinutes > 0) {
      // ND stacks on the applicable rate: night minutes inside the OT tail
      // of the day earn 10% of the OT rate; attendance attributes the
      // overlap chronologically (ndOtMinutes), so morning night-work inside
      // the standard day is not mistaken for night overtime.
      const ndOt = Math.min(d.ndOtMinutes ?? Math.min(d.nightDiffMinutes, d.otMinutes), d.nightDiffMinutes)
      const ndRegular = d.nightDiffMinutes - ndOt
      ndPay +=
        (ndRegular / 60) * hourly * settings.nightDiffRate * DAY_MULT[d.dayType] +
        (ndOt / 60) * hourly * settings.nightDiffRate * otMultiplier(d.dayType)
    }
  }

  if (maternityDates.length > 0) {
    notes.push(
      `Maternity leave, ${maternityDates.length} day/s (RA 11210): paid as the maternity benefit, not as salary — the SSS maternity benefit the company advances and any salary differential, both tax-exempt (RMC 105-2019).`,
    )
    // the leave starts in this payroll and no maternity pay is on it yet
    const leaveStart = days.find((d) => d.leaveCode === MATERNITY_LEAVE_CODE)?.leaveStart ?? maternityDates[0]
    if (leaveStart >= period.start && !(employee.oneTimeEarnings ?? []).some((e) => e.benefit)) {
      warnings.push(
        `Maternity leave from ${shortDate(leaveStart)}: add the SSS maternity benefit (advanced in full within 30 days of the leave application) and any salary differential up to full pay as adjustments — "SSS maternity benefit" and "Salary differential (before employee contributions)"; the payroll paying them takes the employee's contributions for the leave months. Retail and service businesses with not more than 10 workers, micro-businesses and distressed establishments may be exempted by DOLE from the differential: record the exemption in Client Settings.`,
      )
    }
  }

  // ---- earnings ----
  const earnings: PayLine[] = []
  const earn = (code: string, label: string, amount: number, bir: BirBucket, extra: Partial<PayLine> = {}) =>
    earnings.push({ code, label, amount, bir, taxable: isTaxableBucket(bir, isMwe), ...extra })
  // a Christmas bonus and an allowance subject to liquidation are not SSS
  // compensation; commissions, profit sharing and fees have their own 2316 items
  const notSss = (t: PayItemType | undefined) =>
    t === 'christmas_bonus' || t === 'liquidated_allowance' ? ' (not SSS compensation)' : ''
  const itemBucket = (category: BirBucket, t: PayItemType | undefined): BirBucket =>
    t === 'commission' || t === 'profit_sharing' || t === 'fees' ? t : category
  // De minimis benefits are exempt up to their ceilings, and only those on
  // the list: any other benefit is taxable, and so is pay above a ceiling
  // (RR 2-98 Sec. 2.78.1(A)(3) as amended by RR 29-2025 Sec. 1; RR 5-2011
  // Sec. 1, the list is exclusive). The ceilings count what earlier payrolls
  // of the month, semester or year paid.
  const dmUsed: Partial<Record<DeMinimisKind, DeMinimisUsed>> = Object.fromEntries(
    Object.entries(params.deMinimisUsed ?? {}).map(([k, v]) => [k, { ...v }]),
  )
  const roomFor = (kind: DeMinimisKind): number => {
    const c = tables.de_minimis?.ceilings[kind]
    if (!c) return 0
    const u = dmUsed[kind] ?? { month: 0, semester: 0, year: 0 }
    switch (c.per) {
      case 'month': return c.limit - u.month
      case 'semester': return c.limit - u.semester
      case 'ot_day_of_minimum_wage': return round2(c.limit * settings.minimumWageDaily * overtimeOrNightDays) - (u.payroll ?? 0)
      default: return c.limit - u.year
    }
  }
  const consume = (kind: DeMinimisKind, amount: number) => {
    const u = dmUsed[kind] ?? { month: 0, semester: 0, year: 0 }
    dmUsed[kind] = { month: u.month + amount, semester: u.semester + amount, year: u.year + amount, payroll: (u.payroll ?? 0) + amount }
  }
  const earnDeMinimis = (code: string, label: string, amount: number, kind: DeMinimisKind | undefined, id?: string) => {
    if (!kind || !tables.de_minimis?.ceilings[kind]) {
      earn(code, `${label} (not a de minimis benefit: taxable)`, amount, 'other_supplementary', { meta: id })
      warnings.push(
        !kind
          ? `${label}: not on the de minimis list, so it is taxable compensation (RR 5-2011 Sec. 1: the list is exclusive). Pick the de minimis benefit it is, or classify it as taxable.`
          : `${label}: no de minimis ceilings are in force for this pay date, so it is taxed. The system maintainer publishes the ceilings.`,
      )
      return
    }
    const exempt = round2(Math.min(amount, Math.max(0, roomFor(kind))))
    if (exempt > 0) {
      earn(code, `${label} (de minimis)`, exempt, 'de_minimis', { meta: id, dm: kind })
      consume(kind, exempt)
    }
    const excess = round2(amount - exempt)
    if (excess > 0) earn('de_minimis_excess', `${label} (above the de minimis ceiling: taxable)`, excess, 'other_supplementary', { meta: id, dm: kind })
  }
  // Unused leave converted to cash: de minimis up to the yearly days ceiling
  // when the client grants vacation leave (5 days or more: outside SIL,
  // Labor Code Art. 95(b)); a SIL-only client's conversion is taxable unless
  // it decides otherwise (O7).
  const earnLeaveConversion = (label: string, amount: number, days: number, id?: string) => {
    const vlClient = (settings.paidVlDaysPerYear ?? 0) >= LEAVE.vacationLeaveOutsideSil.value
    if (!vlClient && settings.silConversionTaxable !== false) {
      earn('leave_conversion', `${label} (service incentive leave converted to cash: taxable)`, amount, 'other_supplementary', { meta: id, leaveDays: days })
      return
    }
    const c = tables.de_minimis?.ceilings.monetized_vl
    const exemptDays = c ? Math.max(0, Math.min(days, c.limit - (dmUsed.monetized_vl?.year ?? 0))) : 0
    const exempt = round2((amount * exemptDays) / days)
    if (exempt > 0) {
      earn('adjustment', `${label} (de minimis, ${exemptDays} day/s)`, exempt, 'de_minimis', { meta: id, dm: 'monetized_vl', leaveDays: exemptDays })
      consume('monetized_vl', exemptDays)
    }
    const excess = round2(amount - exempt)
    if (excess > 0) {
      earn('de_minimis_excess', `${label} (above the ${c?.limit ?? 0}-day de minimis ceiling: taxable)`, excess, 'other_supplementary', {
        meta: id,
        dm: 'monetized_vl',
        leaveDays: round2(days - exemptDays),
      })
    }
  }
  // an MWE's hazard pay is exempt only for an actual assignment to a danger,
  // strife-torn or disease-infested area or a distressed or isolated station,
  // certified by DOLE or an allied agency (RR 2-98 Sec. 2.78.1(B)(13))
  const uncertifiedHazard = (bucket: BirBucket) => isMwe && bucket === 'hazard' && !employee.hazardCertificationRef?.trim()
  let basicPay: number

  if (extrasOnly) {
    basicPay = 0
    notes.push('Final pay after the last paid period: one-time items, tax adjustment and rounding settlement only.')
  } else if (employee.payType === 'monthly') {
    basicPay = allocateMonthly(employee.monthlyRate, period.index, period.count)
    earn('basic', 'Basic Pay', basicPay, 'basic')
    // days not paid never take more than the period's salary (a month of 23
    // weekdays holds more than the divisor's average share of days)
    let salaryLeft = basicPay
    const dock = (amount: number) => {
      const taken = Math.min(salaryLeft, round2(amount))
      salaryLeft = round2(salaryLeft - taken)
      return taken
    }
    // a period wholly on maternity leave pays no salary, whatever its number
    // of workdays (the maternity benefit replaces it)
    const wholePeriodOnLeave = days.length > 0 && days.every((d) => d.leaveCode === MATERNITY_LEAVE_CODE && d.workedMinutes <= 0)
    const maternityDeduction = dock(wholePeriodOnLeave ? basicPay : maternityPayDays * daily)
    if (maternityDeduction > 0) {
      earn('maternity', `Maternity leave (${maternityDates.length} day/s, paid as the maternity benefit)`, -maternityDeduction, 'basic')
    }
    const absenceDeduction = dock(absencePayDays * daily)
    if (absenceDeduction > 0) {
      const n = absentDays + unpaidLeaveDays
      const share = round2(absencePayDays)
      earn('absence', `Absences (${n} day/s${share !== n ? `, ${share} days' pay` : ''})`, -absenceDeduction, 'basic')
    }
    const unpaidHolidayDeduction = dock(unpaidHolidayDays * daily)
    if (unpaidHolidayDeduction > 0) {
      earn('holiday_unpaid', `Regular holiday not paid (${unpaidHolidayDays} day/s)`, -unpaidHolidayDeduction, 'basic')
    }
    const outsideDeduction = dock(outsideEmploymentDays * daily)
    if (outsideDeduction > 0) {
      earn('outside_employment', `Holidays before the hire date or after the last day (${outsideEmploymentDays} day/s)`, -outsideDeduction, 'basic')
    }
    const lateDeduction = dock(lateMin * perMinute)
    if (lateDeduction > 0) {
      earn('late', `Tardiness (${lateMin} min)`, -lateDeduction, 'basic')
    }
    const undertimeDeduction = dock(undertimeMin * perMinute)
    if (undertimeDeduction > 0) {
      earn('undertime', `Undertime (${undertimeMin} min)`, -undertimeDeduction, 'basic')
    }
    if (extraRegularMinutes > 0) {
      earn(
        'extra_hours',
        `Hours past the shift (${round2(extraRegularMinutes / 60)}h at the regular rate)`,
        round2(extraRegularMinutes * perMinute),
        'basic',
        { hours: round2(extraRegularMinutes / 60) },
      )
    }
    if (period.count > 1) {
      notes.push(`Monthly rate allocated as pay period ${period.index} of ${period.count} this month.`)
    }
  } else {
    basicPay = round2(dailyBasic)
    earn(
      'basic',
      `Basic Pay (${daysWorked} day/s worked${paidLeaveDays ? ` + ${paidLeaveDays} paid leave` : ''})`,
      basicPay,
      'basic',
    )
    notes.push('Daily-paid: tardiness/undertime is reflected in payable hours rather than deducted separately.')
  }

  if (otPay > 0) earn('ot', 'Overtime Pay', round2(otPay), 'overtime', { hours: round2(otHours) })
  if (ndPay > 0) earn('nd', 'Night Differential', round2(ndPay), 'night_diff', { hours: round2(ndHours) })
  if (restDayPay > 0) earn('restday', 'Rest Day Pay', round2(restDayPay), 'holiday')
  if (specialDayPremium > 0) earn('special', 'Special Day Premium', round2(specialDayPremium), 'holiday')
  // an MWE's rest-day work: the minimum wage for the day is exempt (not basic
  // salary for the 13th month, as before), the premium is taxable
  if (mweRestDayWage > 0) {
    earn('restday_wage', 'Rest Day Work (minimum wage)', round2(mweRestDayWage), 'basic', { thirteenthBasis: false })
  }
  if (mweRestDayPremium > 0) earn('restday_premium', 'Rest Day Premium (taxable)', round2(mweRestDayPremium), 'premium')
  if (mweSpecialPremium > 0) earn('special_premium', 'Special Day Premium (taxable)', round2(mweSpecialPremium), 'premium')
  if (holidayPremium > 0) earn('holiday', 'Holiday Pay', round2(holidayPremium), 'holiday')
  if (mweHolidayRestPremium > 0) {
    earn('holiday_premium', 'Holiday Rest Day Premium (taxable)', round2(mweHolidayRestPremium), 'premium')
  }

  const paidDays = daysWorked + paidLeaveDays + paidUnworkedHolidays
  for (const a of extrasOnly ? [] : employee.allowances) {
    let amt: number
    let suffix = ''
    if (a.basis === 'per_day') {
      amt = round2(a.amount * paidDays)
      suffix = ` (${paidDays} day/s)`
    } else if (a.basis === 'per_period') {
      amt = round2(a.amount)
    } else {
      amt = allocateMonthly(a.amount, period.index, period.count)
    }
    if (amt === 0) continue
    if (a.category === 'de_minimis') {
      earnDeMinimis('allowance', `${a.label}${suffix}`, amt, a.deMinimisKind)
      continue
    }
    const bucket = itemBucket(a.category, a.payItemType)
    const taxable = isTaxableBucket(bucket, isMwe) || uncertifiedHazard(bucket)
    earn('allowance', `${a.label}${suffix}${taxable ? '' : ' (non-taxable)'}${notSss(a.payItemType)}`, amt, bucket, {
      taxable,
      ...(notSss(a.payItemType) ? { sss: false } : {}),
    })
  }
  for (const e of employee.oneTimeEarnings ?? []) {
    const amt = round2(e.amount)
    if (amt === 0) continue
    if (e.benefit) {
      // maternity pay is tax-exempt (RMC 105-2019); the salary differential
      // counts toward the 13th month, the SSS benefit does not
      earn('adjustment', e.label, amt, 'other_non_taxable', {
        meta: e.id,
        benefit: e.benefit,
        sss: false,
        ...(e.benefit === 'maternity_differential' ? { thirteenthBasis: true } : {}),
      })
      continue
    }
    if (e.leaveDays) {
      earnLeaveConversion(e.label, amt, e.leaveDays, e.id)
      continue
    }
    if (e.category === 'de_minimis') {
      earnDeMinimis('adjustment', e.label, amt, e.deMinimisKind, e.id)
      continue
    }
    const bucket = itemBucket(e.category, e.payItemType)
    earn('adjustment', `${e.label}${notSss(e.payItemType)}`, amt, bucket, {
      meta: e.id,
      ...(uncertifiedHazard(bucket) ? { taxable: true } : {}),
      ...(notSss(e.payItemType) ? { sss: false } : {}),
    })
  }
  if (earnings.some((l) => l.bir === 'hazard' && l.taxable && isMwe)) {
    notes.push(
      "Hazard pay is taxable for this minimum wage earner: it is exempt only with the DOLE or allied agency's certification of an actual assignment to a hazardous area or station on file (RR 2-98 Sec. 2.78.1(B)(13)).",
    )
  }

  const grossPay = round2(earnings.reduce((s, l) => s + l.amount, 0))
  const grossTaxable = round2(earnings.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0))

  // ---- statutory deductions ----
  // Pag-IBIG's monthly compensation is the basic salary plus allowances (up
  // to the maximum fund salary); PhilHealth is on the basic salary
  const allowancesMonthly = round2(
    employee.allowances
      .filter((a) => a.category !== 'other_benefits')
      .reduce(
        (s, a) =>
          s + (a.basis === 'monthly' ? a.amount : a.basis === 'per_period' ? a.amount * period.count : (a.amount * settings.workingDaysDivisor) / 12),
        0,
      ),
  )
  const stat = computeStatutory(statutoryMonthlyBase, settings, period, tables, round2(statutoryMonthlyBase + allowancesMonthly))
  if (!extrasOnly && allowancesMonthly > 0 && statutoryMonthlyBase < tables.pagibig.max_fund_salary) {
    notes.push(`Pag-IBIG on basic salary plus allowances: ₱${round2(statutoryMonthlyBase + allowancesMonthly).toLocaleString()} a month.`)
  }
  // the national government pays a solo parent's or PWD's PhilHealth
  // employee half: nothing deducted, the employer's half as usual, the NG
  // half neither deducted nor remitted (PhilHealth Circular 2026-0015 Secs.
  // V.C, V.E.5, V.F.2; Circular 2026-0017 Sec. V.H; RA 11228)
  const philhealthEeDue = employee.philhealthNg ? 0 : stat.philhealthEe
  if (employee.philhealthNg && !extrasOnly && stat.philhealthEe > 0) {
    notes.push(
      `PhilHealth: the national government pays the employee half (₱${stat.philhealthEe.toLocaleString()} a month) for ${employee.philhealthNg === 'pwd' ? 'a person with disability (PhilHealth Circular 2026-0017; RA 11228)' : 'a solo parent (PhilHealth Circular 2026-0015)'}: "NG share – non-collectible", neither deducted nor remitted; the employer pays its usual half.`,
    )
  }
  // Maternity leave (RA 11210): each month of the leave contributes the usual
  // monthly SSS, PhilHealth and Pag-IBIG on the regular monthly pay, with or
  // without pay that month (IRR of RA 11199 Rule 12 Sec. 6(v); PhilHealth
  // Circular 2018-0001 Sec. III; RA 9679)
  const mat = params.maternity
  const maternityMonth = !extrasOnly && !!mat?.months.some((m) => m.month === mat.thisMonth)
  // A client DOLE exempted from the salary differential (RA 11210 Sec. 5(c);
  // IRR Rule VI Sec. 5; DOLE DA 01-19) — only for a leave that starts while
  // the exemption is valid
  const dole = settings.maternityDifferentialExemption
  const differentialExempt = !!dole && !!mat && mat.leaveStart <= dole.validUntil
  if (dole && mat && !differentialExempt && (maternityMonth || (employee.oneTimeEarnings ?? []).some((e) => e.benefit))) {
    warnings.push(
      `The client's DOLE exemption from the maternity salary differential (${dole.ref}) was valid until ${longDate(dole.validUntil)}: this leave starts ${longDate(mat.leaveStart)}, after it, so the client is not exempt — the salary differential is due.`,
    )
  } else if (differentialExempt && maternityMonth) {
    notes.push(
      `The client is exempt from the maternity salary differential (DOLE ${dole?.ref}, valid until ${longDate(dole?.validUntil ?? '')}): the employee's contributions for the leave months are not taken from the maternity benefit.`,
    )
  }
  if (maternityMonth) {
    notes.push('Maternity leave month: SSS, PhilHealth and Pag-IBIG at the usual monthly amounts on the regular monthly pay.')
  }
  const mc = params.monthContributions
  const share = (monthlyAmount: number, already: number | undefined) => {
    if (extrasOnly) return 0
    // Payrolls of a month can be finalized out of order (a late special run
    // for days before a finalized closing payroll): never deduct beyond
    // what the month still owes.
    const left = round2(Math.max(0, monthlyAmount - (already ?? 0)))
    if (mc?.closes) return left
    if (mc?.opens && settings.contributionTiming === 'first_period') return left
    return Math.min(contributionShare(monthlyAmount, settings.contributionTiming, period), left)
  }
  // SSS follows the month's actual compensation (RA 11199 Sec. 8(f)): the
  // month's closing payroll settles it on everything the month paid, less
  // what earlier payrolls deducted (a refund when they took too much);
  // earlier payrolls deduct a provisional share on the rate. A month that
  // paid no compensation owes none.
  const exactSss = !extrasOnly && !!mc?.closes && mc.compensationAlready !== undefined
  const monthCompensation = exactSss ? round2((mc?.compensationAlready ?? 0) + sssCompensation(earnings, settings)) : 0
  const sssMonth: SssComputation = !exactSss || maternityMonth
    ? stat.sss
    : monthCompensation > 0 ? computeSss(monthCompensation, tables.sss) : NO_SSS
  const settle = (due: number, already: number | undefined) => round2(due - (already ?? 0))
  // a payroll that paid no compensation (a period on maternity or unpaid
  // leave) deducts no provisional SSS: the month's last payroll settles it
  const noSssPay = !exactSss && !!mc && !maternityMonth && sssCompensation(earnings, settings) <= 0
  const sssPart = (due: number, already: number | undefined, rate: number) =>
    exactSss ? settle(due, already) : noSssPay ? 0 : share(rate, already)
  const sssEe = sssPart(sssMonth.ee, mc?.already.sssEe, stat.sss.ee)
  const sssMpfEe = sssPart(sssMonth.mpfEe, mc?.already.sssMpfEe, stat.sss.mpfEe)
  const sssEr = sssPart(sssMonth.er, mc?.already.sssEr, stat.sss.er)
  const sssMpfEr = sssPart(sssMonth.mpfEr, mc?.already.sssMpfEr, stat.sss.mpfEr)
  const sssEcEr = sssPart(sssMonth.ecEr, mc?.already.sssEcEr, stat.sss.ecEr)
  const philhealthEe = share(philhealthEeDue, mc?.already.philhealthEe)
  const pagibigEe = share(stat.pagibigEe, mc?.already.pagibigEe)
  const philhealthEr = share(stat.philhealthEr, mc?.already.philhealthEr)
  const philhealthNg = employee.philhealthNg ? share(stat.philhealthEe, mc?.already.philhealthNg) : 0
  const pagibigEr = share(stat.pagibigEr, mc?.already.pagibigEr)

  if (extrasOnly) {
    notes.push('No statutory contributions: no compensation for work in this payroll.')
    const sep = params.separationMonth
    if (sep) {
      const a = sep.already
      const short = (due: number, done: number) => Math.max(0, due - done)
      const sepSss =
        sep.compensation === undefined ? stat.sss : sep.compensation > 0 ? computeSss(sep.compensation, tables.sss) : NO_SSS
      const ee = round2(
        short(sepSss.ee, a.sssEe) + short(sepSss.mpfEe, a.sssMpfEe) +
          short(philhealthEeDue, a.philhealthEe) + short(stat.pagibigEe, a.pagibigEe),
      )
      const er = round2(
        short(sepSss.er, a.sssEr) + short(sepSss.mpfEr, a.sssMpfEr) + short(sepSss.ecEr, a.sssEcEr) +
          short(stat.philhealthEr, a.philhealthEr) + short(stat.pagibigEr, a.pagibigEr),
      )
      // SSS on the month's actual pay can also be over-deducted (a provisional share on the rate)
      const overEe = round2(Math.max(0, a.sssEe - sepSss.ee) + Math.max(0, a.sssMpfEe - sepSss.mpfEe))
      if (ee > 0 || er > 0 || overEe > 0) {
        warnings.push(
          `${sep.label} contributions are short by ₱${ee.toLocaleString()} (employee) and ₱${er.toLocaleString()} (employer)${overEe > 0 ? `, and ₱${overEe.toLocaleString()} of the employee's SSS was over-deducted` : ''}: the payroll holding the last day was finalized before the separation was recorded. Reopen and recompute that payroll so it completes the month.`,
        )
      }
    }
  } else if (mc?.closes && (period.index < period.count || Object.values(mc.already).some((v) => v > 0))) {
    notes.push("Statutory contributions complete this month's amounts (less what earlier payrolls this month deducted).")
  } else if (mc?.opens && settings.contributionTiming === 'first_period' && period.index > 1) {
    notes.push("First payroll of the month for this employee: the month's statutory contributions are deducted here.")
  } else if (stat.periodFactor === 0) {
    notes.push('Statutory contributions are deducted on another payroll of this month (per client settings).')
  } else if (stat.periodFactor < 1) {
    notes.push(`Statutory contributions are split evenly across the ${period.count} payrolls of the month.`)
  }
  if (exactSss && maternityMonth) {
    notes.push(`SSS on the regular monthly pay ₱${statutoryMonthlyBase.toLocaleString()} (MSC ₱${stat.sss.msc.toLocaleString()}), less what earlier payrolls this month deducted.`)
  } else if (exactSss) {
    const earlier = round2(mc?.compensationAlready ?? 0)
    notes.push(
      monthCompensation > 0
        ? `SSS on the month's compensation ₱${monthCompensation.toLocaleString()} (MSC ₱${sssMonth.msc.toLocaleString()}${earlier > 0 ? `; ₱${earlier.toLocaleString()} of it paid by earlier payrolls this month` : ''}), less what earlier payrolls deducted.`
        : 'No SSS contribution: the month paid no compensation.',
    )
  } else if (noSssPay && !extrasOnly) {
    notes.push("No SSS this payroll: it paid no compensation; the month's last payroll settles the month.")
  } else if (!extrasOnly) {
    notes.push(
      mc && !mc.closes
        ? `SSS provisional on the monthly rate ₱${statutoryMonthlyBase.toLocaleString()} (MSC ₱${stat.sss.msc.toLocaleString()}); the month's last payroll settles it on actual compensation.`
        : `SSS MSC ₱${stat.sss.msc.toLocaleString()} on statutory monthly base ₱${statutoryMonthlyBase.toLocaleString()}.`,
    )
  }

  const deductions: PayLine[] = []
  // a negative amount refunds what earlier payrolls of the month over-deducted
  if (sssEe !== 0) deductions.push({ code: 'sss', label: sssEe < 0 ? 'SSS Contribution refund (over-deducted earlier this month)' : 'SSS Contribution', amount: sssEe })
  if (sssMpfEe !== 0) {
    deductions.push({ code: 'sss_mpf', label: sssMpfEe < 0 ? 'SSS MySSS Pension Booster (MPF) refund' : 'SSS MySSS Pension Booster (MPF)', amount: sssMpfEe })
  }
  if (philhealthEe > 0) deductions.push({ code: 'philhealth', label: 'PhilHealth Premium', amount: philhealthEe })
  if (pagibigEe > 0) deductions.push({ code: 'pagibig', label: 'Pag-IBIG Contribution', amount: pagibigEe })

  // Maternity leave: the employee's shares for the leave months come out of
  // the maternity pay (RA 11210 Sec. 5(c); IRR Rule VI Sec. 5). A leave month
  // uses what the maternity pay prepaid for it, then its own pay; what is
  // left waits for the maternity pay — or, at a client exempt from the
  // differential, the employer advances it as an employee share to collect (O3).
  const maternityPay = round2(earnings.filter((l) => l.benefit).reduce((s, l) => s + l.amount, 0))
  const eeHere = round2(sssEe + sssMpfEe + philhealthEe + pagibigEe)
  // what this payroll's own pay funds of its share (the maternity pay included)
  let fromPayHere = 0
  if (maternityMonth && mat && eeHere > 0) {
    const m = mat.months.find((x) => x.month === mat.thisMonth)
    const fromPrepaid = round2(Math.min(eeHere, Math.max(0, (m?.covered ?? 0) - (m?.prepaidUsed ?? 0))))
    if (fromPrepaid > 0) deductions.push({ code: 'ee_prepaid', label: 'Employee contributions paid from the maternity pay', amount: -fromPrepaid })
    const rest = round2(eeHere - fromPrepaid)
    const ownPay = Math.max(0, grossPay - (differentialExempt ? maternityPay : 0))
    const short = round2(rest - Math.min(rest, ownPay))
    fromPayHere = round2(rest - short)
    if (short > 0 && differentialExempt) {
      deductions.push({ code: 'ee_collect', label: 'Employee share to collect (advanced by the employer)', amount: -short })
      warnings.push(
        `Employee share to collect: ₱${plainAmount(short)} of the employee's SSS, PhilHealth and Pag-IBIG for this leave month is remitted by the employer and owed back by the employee — the client is exempt from the salary differential, so the maternity benefit is not reduced.`,
      )
    } else if (short > 0) {
      deductions.push({ code: 'ee_pending', label: 'Employee contributions to be deducted from the maternity pay', amount: -short })
    }
  }
  // the payroll paying the maternity pay takes the shares of every leave
  // month not yet funded: owed by payrolls already paid, prepaid for payrolls
  // to come — its own month's other payrolls included (the month's usual
  // share less what its pay, earlier payouts and this payroll funded)
  if (mat && maternityPay > 0 && !differentialExempt) {
    const usual = round2(stat.sss.ee + stat.sss.mpfEe + philhealthEeDue + stat.pagibigEe)
    const covers = mat.months
      .map((m) => ({
        month: m.month,
        amount: round2(
          Math.max(0, Math.max(usual, m.charged) - m.fundedByPay - m.covered - (m.month === mat.thisMonth ? fromPayHere : 0)),
        ),
      }))
      .filter((c) => c.amount > 0)
    if (covers.length > 0) {
      deductions.push({
        code: 'maternity_contributions',
        label: `Employee contributions for the maternity leave months (${covers.map((c) => monthName(c.month)).join(', ')}), from the maternity pay`,
        amount: round2(covers.reduce((s, c) => s + c.amount, 0)),
        covers,
      })
    }
  }

  // ---- other deductions (needed first: union dues are tax-exempt) ----
  const otherLines: PayLine[] = []
  let otherDeductionsTotal = 0
  let unionDues = 0
  for (const d of employee.extraDeductions) {
    if (d.upToNet) continue // cash advances come last, after tax
    const amt = round2(d.amount)
    if (amt <= 0) continue
    otherDeductionsTotal += amt
    if (d.category === 'union_dues') unionDues += amt
    otherLines.push({
      code: `${d.oneTime ? 'adj' : 'other'}:${d.category}`,
      label: d.label,
      amount: amt,
      meta: d.id,
    })
  }
  otherDeductionsTotal = round2(otherDeductionsTotal)
  unionDues = round2(unionDues)

  // ---- withholding tax ----
  // Mandatory contributions and union dues are excluded from taxable
  // compensation (NIRC Sec. 32(B)(7)(f)); they come out of basic pay first,
  // so for an MWE they only reduce other compensation when they exceed the
  // exempt basic pay of the period.
  const exclusions = sssEe + sssMpfEe + philhealthEe + pagibigEe + unionDues
  // 13th month pay and other benefits are exempt up to the cap per tax year
  // (NIRC Sec. 32(B)(7)(e)); what this payroll pays beyond what is left of it
  // is taxable compensation of this payroll, for minimum wage earners too
  // (Soriano v. Secretary of Finance, G.R. 184450). An annualizing payroll
  // applies the cap to the whole year instead.
  const benefits = round2(
    earnings.filter((l) => l.bir === 'thirteenth' || l.bir === 'other_benefits').reduce((s, l) => s + l.amount, 0),
  )
  const exemptLeft = Math.max(0, params.benefitsExemptLeft ?? tables.bir_annual.other_benefits_exemption_cap)
  const benefitsExcess = params.annualization ? 0 : round2(Math.max(0, benefits - exemptLeft))
  if (benefitsExcess > 0) {
    notes.push(
      `₱${benefitsExcess.toLocaleString()} of this payroll's 13th month pay and other benefits is beyond the ₱${tables.bir_annual.other_benefits_exemption_cap.toLocaleString()} yearly exemption (₱${round2(exemptLeft).toLocaleString()} was left) and is taxed with this payroll.`,
    )
  }
  // Taxable pay in its regular part (basic salary, fixed allowances: 2316
  // items 39–44) and its supplementary part (overtime, premiums, hazard pay,
  // taxable benefits: items 45–51). Exclusions come out of basic pay first —
  // an MWE's exempt basic pay — and then out of the rest.
  const taxablePart = (regular: boolean) =>
    round2(
      earnings
        .filter((l) => l.taxable && !!l.bir && REGULAR_COMPENSATION_BUCKETS.includes(l.bir) === regular)
        .reduce((s, l) => s + l.amount, 0),
    )
  const regularGross = taxablePart(true)
  const supplementaryGross = taxablePart(false)
  let spill = exclusions
  if (isMwe) {
    const exemptBasic = earnings.filter((l) => l.bir === 'basic').reduce((s, l) => s + l.amount, 0)
    spill = Math.max(0, exclusions - Math.max(0, exemptBasic))
    notes.push(
      'Minimum wage earner: statutory minimum wage, holiday, overtime, night differential and hazard pay are exempt from withholding tax.',
    )
  }
  const regularTaxable = round2(Math.max(0, regularGross - spill))
  const supplementaryTaxable = round2(
    Math.max(0, supplementaryGross - Math.max(0, spill - Math.max(0, regularGross))) + benefitsExcess,
  )
  const taxableIncome = round2(regularTaxable + supplementaryTaxable)
  if (grossTaxable < 0) notes.push('Taxable pay is negative this payroll (deductions exceed it): no withholding tax.')

  let withholdingTax: number
  let whtLabel = 'Withholding Tax'
  let taxTrace: TaxTrace = { method: 'annualized', regular: regularTaxable, supplementary: supplementaryTaxable }
  if (params.annualization) {
    const current: AnnualPayslipFact = {
      payMonth: params.annualization.payMonth,
      isMwe,
      earnings,
      contributionsEe: sssEe + sssMpfEe + philhealthEe + pagibigEe,
      unionDues,
      withholdingTax: 0,
    }
    const { withholding, summary } = annualizedWithholding(
      params.annualization.ytd,
      current,
      tables.bir_annual,
      params.annualization.prior,
      params.annualization.peraCredit ?? 0,
    )
    withholdingTax = withholding
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Annualized: taxable compensation for the year ₱${summary.totalTaxable.toLocaleString()} → tax due ₱${summary.taxDue.toLocaleString()}; this payroll withholds the difference from tax already withheld.`,
    )
  } else {
    const r = periodWithholding({
      regular: regularTaxable,
      supplementary: supplementaryTaxable,
      brackets: tables.bir_wht[WHT_TABLE[settings.payFrequency]],
      taxYear: params.taxYear,
    })
    const { tax, ...how } = r
    withholdingTax = tax
    taxTrace = { ...taxTrace, ...how }
    notes.push(...withholdingNotes(r, regularTaxable, supplementaryTaxable, params.taxYear, settings.payFrequency, tables))
  }
  if (withholdingTax !== 0) deductions.push({ code: 'wht', label: whtLabel, amount: withholdingTax })
  deductions.push(...otherLines)
  if (params.annualization) {
    // what this pay holds for the tax after contributions and the other deductions
    const available = round2(grossPay - deductions.filter((l) => l.code !== 'wht').reduce((s, l) => s + l.amount, 0))
    const { advanced } = capShortfall(withholdingTax, available)
    if (advanced > 0) {
      deductions.push({ code: 'tax_advance', label: 'Tax advanced by employer (receivable)', amount: -advanced })
      warnings.push(taxAdvanceWarning(advanced))
    }
  }

  // ---- cash advances: repaid from what is left, never past zero net pay ----
  // They don't touch taxable pay; an installment net pay can't cover stays
  // in the balance for the next payroll (finalize deducts what was taken).
  let leftCents = Math.round((grossPay - deductions.reduce((s, l) => s + l.amount, 0)) * 100)
  for (const d of employee.extraDeductions) {
    if (!d.upToNet) continue
    const dueCents = Math.round(round2(d.amount) * 100)
    if (dueCents <= 0) continue
    const takeCents = Math.min(dueCents, Math.max(0, leftCents))
    leftCents -= takeCents
    const take = takeCents / 100
    if (take > 0) {
      const left = d.balance === undefined ? null : round2(d.balance - take)
      deductions.push({
        code: `other:${d.category}`,
        label: left === null ? d.label : `${d.label} — ${left > 0 ? `${plainAmount(left)} left` : 'fully paid'}`,
        amount: take,
        meta: d.id,
      })
      otherDeductionsTotal = round2(otherDeductionsTotal + take)
    }
    if (takeCents < dueCents) {
      const short = (dueCents - takeCents) / 100
      warnings.push(
        d.settlement
          ? `${d.label}: ₱${plainAmount(short)} of the balance could not be deducted (not enough net pay) and is still owed — collect it outside payroll.`
          : `${d.label}: ₱${plainAmount(short)} of this payroll's installment could not be deducted (not enough net pay); it stays in the balance for later payrolls.`,
      )
    }
  }

  const totalDeductions = round2(deductions.reduce((s, l) => s + l.amount, 0))
  const netExact = round2(grossPay - totalDeductions)
  const r = applyNetPayRounding(netExact, params.rounding)
  if (r.adjustment !== 0 || r.carryOut > 0) {
    notes.push(
      `Cash rounding: computed net ₱${netExact.toFixed(2)}${r.carryIn ? ` + ₱${r.carryIn.toFixed(2)} carried in` : ''} → paid ₱${r.paid.toFixed(2)}${r.carryOut ? `; ₱${r.carryOut.toFixed(2)} carried to the next payroll` : ''}.`,
    )
  }

  // Earned basic = basic net of absence/tardiness/undertime lines (plus
  // basic-pay adjustments). Stored as the payslip's basic_pay because PD
  // 851 counts only "basic salary earned" toward 13th month pay.
  const earnedBasic = round2(
    earnings
      .filter((l) => (l.bir === 'basic' && l.thirteenthBasis !== false) || l.thirteenthBasis === true)
      .reduce((s, l) => s + l.amount, 0),
  )

  if (netExact < 0) warnings.push('Net pay is negative — review deductions for this employee.')
  if (unworkedRegularHolidays > 0) {
    notes.push(`${unworkedRegularHolidays} unworked regular holiday/s in this period.`)
  }

  return {
    employeeId: employee.id,
    runType,
    daysWorked,
    hoursWorked: round2(hoursWorked),
    overtimeHours: round2(otHours),
    nightDiffHours: round2(ndHours),
    lateMinutes: Math.round(lateMin),
    undertimeMinutes: Math.round(undertimeMin),
    absentDays: absentDays + unpaidLeaveDays,
    earnings,
    deductions,
    basicPay: earnedBasic,
    grossPay,
    taxableIncome,
    sssEe,
    sssEr,
    sssEcEr,
    sssMpfEe,
    sssMpfEr,
    philhealthEe,
    philhealthEr,
    philhealthNg,
    pagibigEe,
    pagibigEr,
    withholdingTax,
    unionDues,
    otherDeductionsTotal,
    totalDeductions,
    netPay: r.paid,
    roundingAdjustment: r.adjustment,
    roundingCarryIn: r.carryIn,
    roundingCarryOut: r.carryOut,
    trace: {
      dailyRate: round2(daily),
      hourlyRate: round2(hourly),
      statutoryMonthlyBase,
      notes,
      warnings,
      days: extrasOnly ? [] : params.days,
      tax: taxTrace,
    },
  }
}

/** Plain-language notes on how this payroll's withholding was computed. */
function withholdingNotes(
  r: PeriodTax,
  regular: number,
  supplementary: number,
  taxYear: TaxYearToDate | undefined,
  frequency: PayrollSettingsInput['payFrequency'],
  tables: StatutoryTables,
): string[] {
  const table = `${FREQUENCY_LABEL[frequency]} BIR table`
  if (r.method === 'table') return r.tax > 0 ? [`Withholding tax from the ${table}.`] : []
  if (r.method === 'supplementary') {
    const b = bracketOf(regular, tables.bir_wht[WHT_TABLE[frequency]])
    return [
      `Supplementary pay ₱${supplementary.toLocaleString()} is taxed at the rate of the regular pay's bracket in the ${table} (${Math.round(b.rate * 100)}% over ₱${b.over.toLocaleString()}), applied to regular + supplementary pay (RR 2-98 Sec. 2.79(B)(3)).`,
    ]
  }
  const why = taxYear?.cumulative
    ? 'in use for this employee this year'
    : supplementary >= regular
      ? 'supplementary pay is at least the regular pay'
      : 'the regular pay is in the zero bracket'
  return [
    `Cumulative average method (RR 2-98 Sec. 2.79(B)(5)(a); ${why}): ₱${(r.cumulative ?? 0).toLocaleString()} taxable this year over ${r.periods} payroll period/s = ₱${(r.average ?? 0).toLocaleString()} a period, taxed on the ${table} and multiplied back, less ₱${round2(taxYear?.withheldBefore ?? 0).toLocaleString()} already withheld this year.`,
  ]
}

/**
 * 13th month pay run (PD 851): 1/12 of basic salary earned within the
 * calendar year, less any installment already paid. Tax-exempt together
 * with other benefits up to the cap in the annual tax table version
 * (₱90,000); the excess is taxed as supplemental compensation at the
 * employee's marginal rate.
 */
function computeThirteenthMonth(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, tables, days, runType } = params
  const notes: string[] = []
  const warnings: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)

  const ytdBasic = params.ytdBasicPay ?? 0
  const alreadyPaid = params.ytdThirteenthPaid ?? 0
  const otherBenefits = params.ytdOtherBenefits ?? 0
  const priorExempt = params.priorThirteenthOtherBenefitsExempt ?? 0
  const gross13 = round2(Math.max(0, ytdBasic / EMPLOYMENT.thirteenthMonthDivisor.value - alreadyPaid))
  const cap = tables.bir_annual.other_benefits_exemption_cap
  const usedThisTaxYear = params.taxYearBenefitsPaid ?? otherBenefits + alreadyPaid
  const exemptRemaining = Math.max(0, cap - priorExempt - usedThisTaxYear)
  const taxable13 = round2(Math.max(0, gross13 - exemptRemaining))

  notes.push(`13th month = 1/12 of YTD basic pay ₱${ytdBasic.toLocaleString()} (PD 851).`)
  if (alreadyPaid > 0) notes.push(`Less 13th month already paid this year: ₱${alreadyPaid.toLocaleString()}.`)
  notes.push(
    `Tax-exempt cap for 13th month + other benefits: ₱${cap.toLocaleString()}; already used this tax year: ₱${round2(priorExempt + usedThisTaxYear).toLocaleString()}.`,
  )
  if (ytdBasic === 0) warnings.push('YTD basic pay is zero — no finalized payslips found for this year.')

  const earnings: PayLine[] = gross13 > 0
    ? [{ code: 'thirteenth', label: '13th Month Pay', amount: gross13, taxable: false, bir: 'thirteenth' }]
    : []

  // The 13th month pay is SSS compensation of its month (client setting,
  // default on): the month's closing payroll settles SSS on it — or, when
  // that payroll was already final, this one trues the month up (RA 11199
  // Sec. 8(f); IRR Rule 12 Sec. 6).
  const mc = params.monthContributions
  let sss = { ee: 0, mpfEe: 0, er: 0, mpfEr: 0, ecEr: 0 }
  if (mc?.closes && mc.compensationAlready !== undefined && gross13 > 0) {
    const monthComp = round2(mc.compensationAlready + sssCompensation(earnings, settings))
    const due = computeSss(monthComp, tables.sss)
    const more = (d: number, done: number) => round2(Math.max(0, d - done))
    sss = {
      ee: more(due.ee, mc.already.sssEe),
      mpfEe: more(due.mpfEe, mc.already.sssMpfEe),
      er: more(due.er, mc.already.sssEr),
      mpfEr: more(due.mpfEr, mc.already.sssMpfEr),
      ecEr: more(due.ecEr, mc.already.sssEcEr),
    }
    if (sss.ee + sss.mpfEe + sss.er + sss.mpfEr + sss.ecEr > 0) {
      notes.push(
        `SSS on the month's compensation with this 13th month pay: ₱${monthComp.toLocaleString()} (MSC ₱${due.msc.toLocaleString()}), less what the month's payrolls deducted.`,
      )
    }
  }

  let withholdingTax = 0
  let whtLabel = 'Withholding Tax (13th month excess)'
  let taxTrace: TaxTrace = { method: 'table', regular: 0, supplementary: taxable13 }
  if (params.annualization) {
    taxTrace = { method: 'annualized', regular: 0, supplementary: taxable13 }
    // Paid after the year's tax was already annualized (last December
    // payroll or final pay): true up the year again so it still reconciles.
    const { withholding, summary } = annualizedWithholding(
      params.annualization.ytd,
      {
        payMonth: params.annualization.payMonth,
        isMwe: employee.isMinimumWageEarner,
        earnings,
        // the SSS this payroll deducts counts in the year's contributions
        contributionsEe: round2(sss.ee + sss.mpfEe),
        unionDues: 0,
        withholdingTax: 0,
      },
      tables.bir_annual,
      params.annualization.prior,
      params.annualization.peraCredit ?? 0,
    )
    withholdingTax = withholding
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Paid after this tax year was annualized: tax due for the year ₱${summary.taxDue.toLocaleString()} less tax already withheld.`,
    )
  } else if (taxable13 > 0) {
    // Supplementary pay paid on its own (RR 2-98 Sec. 2.79(B)(3)): taxed at
    // the rate of the bracket of the employee's regular monthly pay, or on
    // the cumulative average method when that is in the zero bracket (a
    // minimum wage earner's), the excess is at least the regular pay, or the
    // method is in use this year. A minimum wage earner's regular pay is
    // exempt, but the excess is not (Soriano v. Secretary of Finance, G.R. 184450).
    const stat = computeStatutory(
      statutoryMonthlyBase,
      { ...settings, payFrequency: 'monthly' },
      { start: '', end: '', index: 1, count: 1 },
      tables,
    )
    const monthlyTaxable = employee.isMinimumWageEarner
      ? 0
      : round2(Math.max(0, statutoryMonthlyBase - stat.sss.ee - stat.sss.mpfEe - stat.philhealthEe - stat.pagibigEe))
    const bracket = bracketOf(monthlyTaxable, tables.bir_wht.monthly)
    const cumulative =
      (params.taxYear?.cumulative ?? false) || (bracket.rate === 0 && bracket.base === 0) || taxable13 >= monthlyTaxable
    if (cumulative) {
      const periodBrackets = tables.bir_wht[WHT_TABLE[settings.payFrequency]]
      const r = periodWithholding({ regular: 0, supplementary: taxable13, brackets: periodBrackets, taxYear: params.taxYear })
      withholdingTax = r.tax
      taxTrace = { method: r.method, regular: 0, supplementary: taxable13, cumulative: r.cumulative, average: r.average, periods: r.periods }
      notes.push(...withholdingNotes(r, 0, taxable13, params.taxYear, settings.payFrequency, tables))
    } else {
      withholdingTax = round2(bracket.rate * taxable13)
      taxTrace = { method: 'supplementary', regular: monthlyTaxable, supplementary: taxable13 }
      notes.push(
        `₱${taxable13.toLocaleString()} of the 13th month pay exceeds the exemption cap: taxed at ${Math.round(bracket.rate * 100)}%, the rate of the bracket of the regular monthly pay (RR 2-98 Sec. 2.79(B)(3)).`,
      )
    }
  }

  const deductions: PayLine[] = []
  if (sss.ee > 0) deductions.push({ code: 'sss', label: 'SSS Contribution (13th month pay)', amount: sss.ee })
  if (sss.mpfEe > 0) deductions.push({ code: 'sss_mpf', label: 'SSS MySSS Pension Booster (MPF, 13th month pay)', amount: sss.mpfEe })
  if (withholdingTax !== 0) deductions.push({ code: 'wht', label: whtLabel, amount: withholdingTax })
  const { advanced } = capShortfall(withholdingTax, round2(gross13 - sss.ee - sss.mpfEe))
  if (params.annualization && advanced > 0) {
    deductions.push({ code: 'tax_advance', label: 'Tax advanced by employer (receivable)', amount: -advanced })
    warnings.push(taxAdvanceWarning(advanced))
  }

  const totalDeductions = round2(deductions.reduce((s, l) => s + l.amount, 0))
  const netExact = round2(gross13 - totalDeductions)
  const r = applyNetPayRounding(netExact, params.rounding)
  if (r.adjustment !== 0 || r.carryOut > 0) {
    notes.push(`Cash rounding: computed net ₱${netExact.toFixed(2)} → paid ₱${r.paid.toFixed(2)}.`)
  }

  return {
    employeeId: employee.id,
    runType,
    daysWorked: 0,
    hoursWorked: 0,
    overtimeHours: 0,
    nightDiffHours: 0,
    lateMinutes: 0,
    undertimeMinutes: 0,
    absentDays: 0,
    earnings,
    deductions,
    // 13th month pay is not basic salary: it never feeds a later 13th month.
    basicPay: 0,
    grossPay: gross13,
    taxableIncome: taxable13,
    sssEe: sss.ee,
    sssEr: sss.er,
    sssEcEr: sss.ecEr,
    sssMpfEe: sss.mpfEe,
    sssMpfEr: sss.mpfEr,
    philhealthEe: 0,
    philhealthEr: 0,
    philhealthNg: 0,
    pagibigEe: 0,
    pagibigEr: 0,
    withholdingTax,
    unionDues: 0,
    otherDeductionsTotal: 0,
    totalDeductions,
    netPay: r.paid,
    roundingAdjustment: r.adjustment,
    roundingCarryIn: r.carryIn,
    roundingCarryOut: r.carryOut,
    trace: {
      dailyRate: round2(daily),
      hourlyRate: round2(hourly),
      statutoryMonthlyBase,
      notes,
      warnings,
      days,
      tax: taxTrace,
    },
  }
}

function taxAdvanceWarning(advanced: number): string {
  return `₱${plainAmount(advanced)} of the tax shortfall is more than this pay can bear: the employer pays it with this month's 1601-C, the 2316 shows it as withheld, and it is recorded as "Tax advanced by employer", a receivable to collect from the employee. No shortfall carries into January.`
}

/** 1234.5 -> "1,234.50": payslip lines print in PDFs, whose fonts have no peso sign. */
function plainAmount(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-03-01 -> Mar 2026 */
function monthName(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
}

/** 2026-12-31 -> Dec 31, 2026 */
function longDate(iso: string): string {
  return `${shortDate(iso)}, ${iso.slice(0, 4)}`
}

/** 2026-10-06 -> Oct 6 (warnings name dates without depending on the browser's locale). */
function shortDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`
}
