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
//    as amended) for the employee's pay frequency, by the regular method or
//    the cumulative average method (withholding.ts); annual graduated table
//    when the payroll annualizes (year-end or separation). Union dues and
//    mandatory contributions are excluded from taxable compensation; the
//    statutory minimum wage package of MWEs is exempt. Taxable pay is split
//    into regular (R) and supplementary (S) compensation by pay code.
//  - 13th month pay (PD 851): 1/12 of basic salary earned in the calendar
//    year (installments supported); tax-exempt together with other benefits
//    up to the statutory cap.

import { annualizedWithholding, isTaxableBucket, type AnnualPayslipFact, type PriorEmployerInput } from './annual'
import { lineIncomeClass, PAY_CODES, payCodeForAllowanceCategory, payCodeForEarningCategory, payCodeOf } from './payCodes'
import { computePagibig, computePhilHealth, computeSss } from './statutory'
import {
  round2,
  type AllowanceInput,
  type BirBucket,
  type ContributionTiming,
  type DayComputation,
  type DayType,
  type DeMinimisItem,
  type IncomeClass,
  type LeavePolicy,
  type PagibigData,
  type PayCode,
  type PayLine,
  type PayrollEmployeeInput,
  type PayrollSettingsInput,
  type PayslipComputation,
  type PeriodInput,
  type RoundingInput,
  type RunType,
  type SssComputation,
  type StatutoryComputation,
  type PayrollRules,
  type StatutoryTables,
  type WhtMethod,
} from './types'
import { DEFAULT_PAYROLL_RULES } from './defaults'
import { capYearEndWithholding, periodWithholding, type PeriodWithholding, type PriorWithholding, type WithholdingYtdFact } from './withholding'

export const DAY_MULT: Record<DayType, number> = {
  regular: 1,
  rest_day: 1.3,
  special_day: 1.3,
  special_day_rest: 1.5,
  regular_holiday: 2.0,
  regular_holiday_rest: 2.6,
}

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

// Basis: RR 2-98 §2.78.1(B)(13) and §2.79(A), as amended by RR 11-2018 §§6–7. The exemption covers only "holiday pay, overtime pay, night shift differential pay, and hazard pay". RMC 50-2018 A13 says income outside that list is taxable. Labor Code (PD 442) Art. 93 covers rest-day and special-holiday "additional compensation"; Art. 94 covers holiday pay.
/**
 * A minimum wage earner's pay for a day above what stays exempt, as a
 * multiple of the day's rate: on a rest day or a special day the pay at the
 * SMW rate (100%) is exempt and the additional compensation (30%, 50% for a
 * special day on a rest day) is not; on a regular holiday holiday pay up to
 * 200% is exempt and anything above it (a regular holiday on a rest day) is not.
 */
export function premiumAddOnMultiplier(dayType: DayType): number {
  const exempt = isRegularHolidayType(dayType) ? 2 : 1
  return Math.max(0, DAY_MULT[dayType] - exempt)
}

function otMultiplier(dayType: DayType): number {
  return dayType === 'regular' ? 1.25 : DAY_MULT[dayType] * 1.3
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

/** What the withholding method needs besides this payroll (spec T2). */
export interface WithholdingInput {
  /** The payroll's pay date: it places the payroll in the tax year and counts the CAM periods. */
  payDate: string
  /** This employer's finalized payslips paid earlier in the tax year. */
  ytd: WithholdingYtdFact[]
  /** Previous employers this calendar year: trigger (c), and their pay and tax in CAM. */
  prior?: PriorWithholding | null
}

export interface ComputePayslipParams {
  employee: PayrollEmployeeInput
  settings: PayrollSettingsInput
  period: PeriodInput
  tables: StatutoryTables
  days: DayComputation[]
  runType: RunType
  /** The pay codes on file (omitted: the shipped list, src/payroll/payCodes.ts). */
  payCodes?: readonly PayCode[]
  /** Omitted: the period end is the pay date and nothing was paid earlier this year. */
  withholding?: WithholdingInput
  /** The PENDING rules company admins set (omitted: the defaults, today's rules). */
  rules?: PayrollRules
  /** The client has a DOLE exemption from the maternity salary differential for the payroll year (RA 11210 Sec. 5(c)). */
  maternityDifferentialExempt?: boolean
  /** Pay dates of the employee's finalized payslips that paid a maternity salary differential. */
  maternityDifferentialPaid?: string[]
  /** The client's leave policy: how cash conversion of unused leave is taxed (omitted: SIL only). */
  leavePolicy?: LeavePolicy
  /**
   * What each de minimis item already used in its ceiling's month, semester
   * or year (pesos; days for item a), from the employee's finalized payslips.
   */
  deMinimisUsed?: Partial<Record<DeMinimisItem, number>>
  /**
   * Hired in the tax year with nothing recorded yet on whether they had
   * another employer earlier in the year (their BIR Form 2316): said on the
   * payslip, since withholding and the year-end adjustment use it (spec T8).
   */
  newHireWithoutTaxYear?: { hireDate: string; year: number }
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
}

/**
 * Payslips from before spec T3 have no SSS flag on their lines: their SSS
 * compensation was these buckets (no bonuses, 13th month, de minimis or
 * other non-taxable pay).
 */
export const SSS_COMPENSATION_BUCKETS: readonly BirBucket[] = [
  'basic', 'holiday', 'overtime', 'night_diff', 'hazard', 'cola',
  'representation', 'transportation', 'housing', 'other_taxable',
]

// Basis: RA 11199 §8(f), §8(h) (approved Feb 7, 2019). SSS IRR of RA 11199, Rule 12 §6 ("All actual remuneration for employment … including but not limited to"; "Bonuses (except Christmas bonus)"; "Maternity leave with pay"; transportation, board and lodging allowance "if not subject to liquidation"; "Commission advances and monthly allowances") and Rule 12 §8 (SSS site).
/**
 * SSS compensation in these lines: each line's own flag (its pay code's
 * sss_include; the payroll's own lines — basic pay, premiums, overtime,
 * night differential — are always in), or the bucket rule for a line saved
 * before the flag existed.
 */
export function sssCompensation(lines: readonly Pick<PayLine, 'amount' | 'bir' | 'sss'>[]): number {
  return round2(
    lines
      .filter((l) => l.sss ?? (!!l.bir && SSS_COMPENSATION_BUCKETS.includes(l.bir)))
      .reduce((s, l) => s + Number(l.amount), 0),
  )
}

const NO_SSS: SssComputation = { msc: 0, ee: 0, er: 0, ecEr: 0, mpfEe: 0, mpfEr: 0 }

// Basis: RA 9679 §4(b) (compensation means basic monthly salary plus mandated COLA) and §7 (the HDMF Board sets the ceiling). Approved Jul 21, 2009. HDMF Circular 460 was not read.
/**
 * Pag-IBIG's monthly compensation from the components the settings include
 * (spec P5: basic pay, mandated COLA, other regular allowances), and the
 * table with the ceiling in force (the setting, else the statutory table's
 * maximum fund salary).
 */
export function pagibigCompensation(
  monthly: { basic: number; cola: number; otherAllowances: number },
  rules: PayrollRules,
  table: PagibigData,
): { base: number; table: PagibigData; parts: string } {
  const pick = rules.pagibigBase
  const included = [
    pick.basic && { name: 'basic salary', amount: monthly.basic },
    pick.cola && { name: 'COLA', amount: monthly.cola },
    pick.otherAllowances && { name: 'allowances', amount: monthly.otherAllowances },
  ].filter((p): p is { name: string; amount: number } => !!p)
  return {
    base: round2(included.reduce((s, p) => s + p.amount, 0)),
    table: rules.pagibigCeiling ? { ...table, max_fund_salary: rules.pagibigCeiling } : table,
    parts: included.filter((p) => p.amount > 0).map((p) => p.name).join(' plus ') || 'nothing',
  }
}

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

/** An allowance's pay code: its own, or its category's for a row saved before pay codes. */
function allowanceCode(a: AllowanceInput, codes: readonly PayCode[]): PayCode {
  return payCodeOf(a.payCode ?? payCodeForAllowanceCategory(a.category), codes)
}

const CAM_REASON: Record<NonNullable<PeriodWithholding['trigger']>, string> = {
  a: 'regular compensation is in the 0% row of the table and supplementary compensation was paid this year',
  b: 'supplementary compensation is at least the regular compensation',
  c: 'the employee had a previous employer this year',
  earlier: 'it started earlier this year and applies to the rest of the year',
}

const peso = (v: number) => `₱${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Withholding by the regular method or CAM (withholding.ts), with the note
 * that says which and why.
 */
function withholdingFor(
  regular: number,
  supplementary: number,
  params: ComputePayslipParams,
  supplementaryOnly = false,
): { tax: number; method: WhtMethod; note: string | null; warning: string | null } {
  const { settings, tables, period } = params
  const w = params.withholding
  const r = periodWithholding({
    regular,
    supplementary,
    payDate: w?.payDate ?? period.end,
    frequency: settings.payFrequency,
    brackets: tables.bir_wht[WHT_TABLE[settings.payFrequency]],
    ytd: w?.ytd ?? [],
    prior: w?.prior,
    supplementaryOnly,
  })
  const table = `${FREQUENCY_LABEL[settings.payFrequency]} BIR table`
  if (r.method === 'regular') {
    const note = r.tax <= 0
      ? null
      : supplementary > 0
        ? `Withholding tax, regular method: the ${table} row of the regular compensation ${peso(regular)}, applied to it plus the supplementary compensation ${peso(supplementary)}.`
        : `Withholding tax from the ${table}.`
    return { tax: r.tax, method: 'regular', note, warning: null }
  }
  const prior = w?.prior
  const since = r.trigger === 'earlier' && r.since ? ` (since the payroll paid ${shortDate(r.since)})` : ''
  const note =
    `Withholding tax, cumulative average method: ${CAM_REASON[r.trigger!]}${since}. ` +
    `Taxable compensation this year ${peso(r.cum!)}${prior ? `, ${peso(prior.taxable)} of it from the previous employer` : ''}, ` +
    `over ${r.n} ${FREQUENCY_LABEL[settings.payFrequency]} pay period${r.n === 1 ? '' : 's'} from ${shortDate(r.from!)}: ` +
    `tax due ${peso(r.totalDue!)} on the ${table}, less ${peso(r.withheldBefore!)} already withheld${prior ? " (the previous employer's included)" : ''}.`
  const warning = prior && !prior.employedFrom
    ? "The previous employer's employment start date isn't on file, so the cumulative average method counts pay periods from January 1. Enter it with the previous employer's figures (BIR Form 2316) and recompute."
    : null
  return { tax: r.tax, method: 'cam', note, warning }
}

// Basis (₱90,000 ceiling, "benefitsExcess" below): NIRC §32(B)(7)(e), as amended by RA 10963 §9. RR 2-98 §2.78.1(B)(11).
// Basis (taxable compensation, R and S): RR 2-98 §2.78.1(B)(11)–(13), §2.79(A) and §2.79(B)(3) Step 1, as amended by RR 11-2018 §§6–7 (effective Jan 1, 2018). RMC 50-2018 A3, A5, A6, A14 (May 11, 2018). RA 11199 §16.
export function computePayslip(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, period, tables, runType } = params
  if (runType === 'thirteenth_month') return computeThirteenthMonth(params)
  const extrasOnly = params.extrasOnly === true
  const days = extrasOnly ? [] : params.days

  const notes: string[] = []
  const warnings: string[] = []
  if (params.newHireWithoutTaxYear) warnings.push(newHireWarning(params.newHireWithoutTaxYear))
  const errors: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)
  const perMinute = hourly / 60
  const rules = params.rules ?? DEFAULT_PAYROLL_RULES
  const isMwe = employee.isMinimumWageEarner
  const codes = params.payCodes ?? PAY_CODES

  // apprentices and learners may be paid 75% of the minimum (Labor Code Arts. 61 and 73)
  const wageFloor = settings.minimumWageDaily * (employee.apprentice ? 0.75 : 1)
  if (round2(daily) < round2(wageFloor)) {
    warnings.push(
      `Below minimum wage: the daily rate ₱${daily.toFixed(2)} is less than ${employee.apprentice ? '75% of ' : ''}the minimum wage ₱${settings.minimumWageDaily.toFixed(2)}${settings.minimumWageSource ? ` (${settings.minimumWageSource})` : ''}. Pay the difference (pay code "Wage order top-up") and update the rate.`,
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

  // the workday-before rule is a client setting (spec T12): "pay anyway" pays every unworked regular holiday
  const holidayPaid =
    settings.holidayPayAfterAbsence === 'pay_anyway' ? new Map<string, boolean>() : unworkedHolidaysPaid([...(params.daysBefore ?? []), ...days], employed)
  const unpaidHolidays = days.filter((d) => holidayPaid.get(d.date) === false)
  if (unpaidHolidays.length > 0) {
    warnings.push(
      `Regular holiday not paid (${unpaidHolidays.map((d) => `${d.holidayName ?? 'holiday'}, ${shortDate(d.date)}`).join('; ')}): no work or paid leave on the workday before it (IRR Book III, Rule IV, Sec. 6). If the employee worked that day, enter the time and recompute.`,
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
  // a minimum wage earner's premiums above the exempt part (spec T5)
  let restDayAddOn = 0
  let specialDayAddOn = 0
  let holidayAddOn = 0
  const premium = (dayType: DayType, amount: number, addOn: number) => {
    if (dayType === 'rest_day') {
      restDayPay += amount - addOn
      restDayAddOn += addOn
    } else if (dayType === 'special_day' || dayType === 'special_day_rest') {
      specialDayPremium += amount - addOn
      specialDayAddOn += addOn
    } else if (isRegularHolidayType(dayType)) {
      holidayPremium += amount - addOn
      holidayAddOn += addOn
    }
  }
  let dailyBasic = 0 // daily-paid only

  const stdMin = settings.standardHoursPerDay * 60
  // the share of a standard day the date's shift schedules (1 when there is no shift)
  const dayShare = (d: DayComputation) => (d.scheduled ? (d.expectedMinutes ?? stdMin) / stdMin : 1)

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
        const hours = d.payableMinutes / 60
        premium(d.dayType, extraMult * hourly * hours, isMwe ? premiumAddOnMultiplier(d.dayType) * hourly * hours : 0)
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
        premium(d.dayType, (DAY_MULT[d.dayType] - 1) * daily * fraction, isMwe ? premiumAddOnMultiplier(d.dayType) * daily * fraction : 0)
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

  // maternity pay: the SSS benefit and the salary differential, by pay code
  const oneTimeCodes = (employee.oneTimeEarnings ?? []).map((e) => payCodeOf(e.payCode ?? payCodeForEarningCategory(e.category, e.benefit), codes))
  const differentialCode = payCodeOf('MAT_DIFFERENTIAL', codes)
  if (maternityDates.length > 0) {
    notes.push(
      `Maternity leave, ${maternityDates.length} day/s (RA 11210): paid as the maternity benefit, not as salary — the SSS maternity benefit the company advances (tax-exempt) and any salary differential (${differentialCode.tax_treatment === 'exempt' ? 'tax-exempt by setting' : 'taxable as supplementary compensation until its exemption is confirmed'}).`,
    )
    const leaveStart = days.find((d) => d.leaveCode === MATERNITY_LEAVE_CODE)?.leaveStart ?? maternityDates[0]
    // the leave starts in this payroll and no maternity pay is on it yet
    if (leaveStart >= period.start && !oneTimeCodes.some((c) => c.benefit)) {
      warnings.push(
        `Maternity leave from ${shortDate(leaveStart)}: add the SSS maternity benefit (advanced in full within 30 days of the leave application) and any salary differential up to full pay as adjustments — "SSS maternity benefit" and "Maternity salary differential".`,
      )
    }
    // Basis: RA 11210 §5(c) (approved Feb 20, 2019; each exemption needs annual DOLE approval).
    // The differential is due unless the client's DOLE exemption covers the
    // payroll year; one paid earlier in this leave is enough.
    const differentialPaid =
      oneTimeCodes.some((c) => c.benefit === 'maternity_differential') ||
      (params.maternityDifferentialPaid ?? []).some((d) => d >= leaveStart)
    if (!differentialPaid && !params.maternityDifferentialExempt) {
      errors.push('Differential required: no DOLE exemption approval for this year')
    }
  }

  // ---- earnings ----
  const earnings: PayLine[] = []
  // an MWE's hazard pay is exempt only with the criteria met and a DOLE
  // certification on file (spec T5)
  const lineTaxable = (bir: BirBucket) => (bir === 'hazard' && isMwe ? !employee.hazardExempt : isTaxableBucket(bir, isMwe))
  // taxable lines are regular (R) or supplementary (S) compensation: basic
  // pay is R, premiums, overtime and night differential are S
  let regularLines = 0
  let supplementaryLines = 0
  const earn = (
    code: string,
    label: string,
    amount: number,
    bir: BirBucket,
    extra: Partial<PayLine> = {},
    incomeClass: IncomeClass = bir === 'basic' ? 'regular' : 'supplementary',
  ) => {
    const taxable = lineTaxable(bir)
    // the payroll's own lines are compensation for work: always in the SSS base
    earnings.push({ code, label, amount, bir, taxable, sss: true, ...extra, ...(taxable ? { incomeClass } : {}) })
    if (!taxable) return
    if (incomeClass === 'regular') regularLines = round2(regularLines + amount)
    else supplementaryLines = round2(supplementaryLines + amount)
  }
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
    const maternityDeduction = dock(maternityPayDays * daily)
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
  if (round2(restDayPay) > 0) earn('restday', 'Rest Day Pay', round2(restDayPay), 'holiday')
  if (round2(specialDayPremium) > 0) earn('special', 'Special Day Premium', round2(specialDayPremium), 'holiday')
  if (round2(holidayPremium) > 0) earn('holiday', 'Holiday Pay', round2(holidayPremium), 'holiday')
  // a minimum wage earner's premiums above the exempt part: taxable S, outside
  // the MWE boxes of the 2316 (spec T5)
  if (round2(restDayAddOn) > 0) earn('restday_addon', 'Rest Day Premium (taxable)', round2(restDayAddOn), 'other_taxable', {}, 'supplementary')
  if (round2(specialDayAddOn) > 0) earn('special_addon', 'Special Day Premium (taxable)', round2(specialDayAddOn), 'other_taxable', {}, 'supplementary')
  if (round2(holidayAddOn) > 0) earn('holiday_addon', 'Holiday Pay above 200% (taxable)', round2(holidayAddOn), 'other_taxable', {}, 'supplementary')

  const paidDays = daysWorked + paidLeaveDays + paidUnworkedHolidays
  // Basis: RR 2-98 §2.78.1(A)(3), as amended by RR 29-2025 §1 (item (a): cash conversion of unused vacation leave, 12 days a year). RMC 50-2018 A5 (the list is exclusive) and A6 (the excess goes to "other benefits"). Labor Code (PD 442) Art. 95: SIL is a separate leave, not owed where paid vacation leave of at least five days is given.
  // de minimis items: exempt up to the ceiling of the pay date (tracked over
  // its month, semester or year), the excess to the ₱90k bucket (spec T7)
  const ceilings = new Map((tables.de_minimis?.items ?? []).map((c) => [c.item, c]))
  const used: Partial<Record<DeMinimisItem, number>> = { ...(params.deMinimisUsed ?? {}) }
  const leavePolicy = params.leavePolicy ?? 'sil_only'
  // item (j): 30% of the minimum wage for each day of overtime or night work
  const mealDays = days.filter((d) => d.otMinutes > 0 || d.nightDiffMinutes > 0).length
  const deMinimisNotes = new Set<string>()
  const earnDeMinimis = (code: string, label: string, amount: number, pc: PayCode, extra: Partial<PayLine>, lineDays?: number) => {
    const item = pc.de_minimis_item
    const withDays = (d: number | undefined) => (d !== undefined && d > 0 ? { days: d } : {})
    // leave converted under a SIL-only policy is SIL conversion: taxable S
    if (item === 'a' && leavePolicy === 'sil_only') {
      earn(code, `${label} (SIL conversion)`, amount, 'other_taxable', { ...extra, ...withDays(lineDays) }, 'supplementary')
      return
    }
    const ceiling = item ? ceilings.get(item) : undefined
    if (!item || !ceiling) {
      deMinimisNotes.add(
        !item
          ? `"${label}" has no de minimis item, so its ceiling isn't checked: change it to the item's pay code (rice subsidy, uniform, laundry…).`
          : 'No de minimis ceilings on file for this pay date (RR 29-2025 applies to pay dated Jan 7, 2026 and later): de minimis benefits are not checked against a ceiling.',
      )
      earn(code, `${label} (non-taxable)`, amount, 'de_minimis', { ...extra, ...withDays(lineDays) })
      return
    }
    let within: number
    let withinDays: number | undefined
    if (ceiling.unit === 'days_per_year') {
      const lineDayCount = lineDays ?? 0
      withinDays = Math.min(lineDayCount, Math.max(0, ceiling.limit - (used[item] ?? 0)))
      within = lineDayCount > 0 ? round2((amount * withinDays) / lineDayCount) : 0
      used[item] = (used[item] ?? 0) + withinDays
    } else {
      const cap = ceiling.unit === 'share_of_regional_minimum_wage' ? round2(ceiling.limit * settings.minimumWageDaily * mealDays) : ceiling.limit
      within = round2(Math.min(amount, Math.max(0, cap - (used[item] ?? 0))))
      used[item] = round2((used[item] ?? 0) + within)
    }
    const excess = round2(amount - within)
    if (within > 0) earn(code, `${label} (de minimis)`, within, 'de_minimis', { ...extra, ...withDays(withinDays) })
    if (excess > 0) {
      earn(code, `${label} (above the de minimis ceiling)`, excess, 'other_benefits', {
        ...extra,
        ...withDays(lineDays !== undefined ? round2(lineDays - (withinDays ?? 0)) : undefined),
      }, 'supplementary')
    }
  }

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
    const pc = allowanceCode(a, codes)
    if (pc.bir_bucket === 'de_minimis') {
      earnDeMinimis('allowance', `${a.label}${suffix}`, amt, pc, { payCode: pc.code, sss: pc.sss_include })
      continue
    }
    const taxable = lineTaxable(pc.bir_bucket)
    earn('allowance', `${a.label}${suffix}${taxable ? '' : ' (non-taxable)'}`, amt, pc.bir_bucket, { payCode: pc.code, sss: pc.sss_include }, lineIncomeClass(pc, 'allowance'))
  }
  for (const e of employee.oneTimeEarnings ?? []) {
    const amt = round2(e.amount)
    if (amt === 0) continue
    const pc = payCodeOf(e.payCode ?? payCodeForEarningCategory(e.category, e.benefit), codes)
    if (pc.bir_bucket === 'de_minimis') {
      earnDeMinimis('adjustment', e.label, amt, pc, { meta: e.id, payCode: pc.code, sss: pc.sss_include }, e.days)
      continue
    }
    // pay besides basic pay that counts toward the 13th month (the maternity
    // salary differential, a setting: spec P9)
    earn('adjustment', e.label, amt, pc.bir_bucket, {
      meta: e.id,
      payCode: pc.code,
      sss: pc.sss_include,
      ...(pc.include_in_13th_month_base && pc.bir_bucket !== 'basic' ? { thirteenthBasis: true } : {}),
    }, lineIncomeClass(pc, 'one_time'))
  }

  warnings.push(...deMinimisNotes)

  const grossPay = round2(earnings.reduce((s, l) => s + l.amount, 0))

  // ---- statutory deductions ----
  // Pag-IBIG's monthly compensation and ceiling are settings (spec P5);
  // PhilHealth is on the basic salary
  const monthlyOf = (a: AllowanceInput) =>
    a.basis === 'monthly' ? a.amount : a.basis === 'per_period' ? a.amount * period.count : (a.amount * settings.workingDaysDivisor) / 12
  const regularAllowances = employee.allowances.filter((a) => allowanceCode(a, codes).bir_bucket !== 'other_benefits')
  const pagibig = pagibigCompensation(
    {
      basic: statutoryMonthlyBase,
      cola: regularAllowances.filter((a) => allowanceCode(a, codes).bir_bucket === 'cola').reduce((s, a) => s + monthlyOf(a), 0),
      otherAllowances: regularAllowances.filter((a) => allowanceCode(a, codes).bir_bucket !== 'cola').reduce((s, a) => s + monthlyOf(a), 0),
    },
    rules,
    tables.pagibig,
  )
  const stat = computeStatutory(statutoryMonthlyBase, settings, period, { ...tables, pagibig: pagibig.table }, pagibig.base)
  if (!extrasOnly && pagibig.base !== statutoryMonthlyBase && Math.min(pagibig.base, statutoryMonthlyBase) < pagibig.table.max_fund_salary) {
    notes.push(`Pag-IBIG on ${pagibig.parts}: ₱${pagibig.base.toLocaleString()} a month.`)
  }
  // the national government pays a PWD's or solo parent's PhilHealth
  // employee share (RA 11228; RA 11861, PhilHealth Circular 2026-0015)
  const philhealthEeDue = employee.philhealthEeWaiver ? 0 : stat.philhealthEe
  if (employee.philhealthEeWaiver && !extrasOnly && stat.philhealthEe > 0) {
    notes.push(
      employee.philhealthEeWaiver === 'pwd'
        ? `PhilHealth employee share (₱${stat.philhealthEe.toLocaleString()} a month) is paid by the national government for an employed PWD (RA 11228); the employer share is unchanged.`
        : `PhilHealth employee share (₱${stat.philhealthEe.toLocaleString()} a month) is paid by the national government for a solo parent (RA 11861; PhilHealth Circular 2026-0015); the employer share is unchanged.`,
    )
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
  const monthCompensation = exactSss ? round2((mc?.compensationAlready ?? 0) + sssCompensation(earnings)) : 0
  const sssMonth: SssComputation = exactSss ? (monthCompensation > 0 ? computeSss(monthCompensation, tables.sss) : NO_SSS) : stat.sss
  const settle = (due: number, already: number | undefined) => round2(due - (already ?? 0))
  // a payroll that paid no compensation (a period on maternity or unpaid
  // leave) deducts no provisional SSS: the month's last payroll settles it
  const noSssPay = !exactSss && !!mc && sssCompensation(earnings) <= 0
  const sssPart = (due: number, already: number | undefined, rate: number) =>
    exactSss ? settle(due, already) : noSssPay ? 0 : share(rate, already)
  const sssEe = sssPart(sssMonth.ee, mc?.already.sssEe, stat.sss.ee)
  const sssMpfEe = sssPart(sssMonth.mpfEe, mc?.already.sssMpfEe, stat.sss.mpfEe)
  const sssEr = sssPart(sssMonth.er, mc?.already.sssEr, stat.sss.er)
  const sssMpfEr = sssPart(sssMonth.mpfEr, mc?.already.sssMpfEr, stat.sss.mpfEr)
  const sssEcEr = sssPart(sssMonth.ecEr, mc?.already.sssEcEr, stat.sss.ecEr)
  // PhilHealth and Pag-IBIG during maternity leave are not settled (spec P4):
  // as usual unless the setting pauses them on a payroll that is all leave
  const scheduledDays = days.filter((d) => d.scheduled)
  const pausedForMaternity =
    rules.maternityContributions === 'pause_full_leave' &&
    scheduledDays.length > 0 &&
    scheduledDays.every((d) => d.leaveCode === MATERNITY_LEAVE_CODE)
  const paused = (v: number) => (pausedForMaternity ? 0 : v)
  const philhealthEe = paused(share(philhealthEeDue, mc?.already.philhealthEe))
  const pagibigEe = paused(share(stat.pagibigEe, mc?.already.pagibigEe))
  const philhealthEr = paused(share(stat.philhealthEr, mc?.already.philhealthEr))
  const pagibigEr = paused(share(stat.pagibigEr, mc?.already.pagibigEr))
  if (pausedForMaternity) {
    notes.push('No PhilHealth or Pag-IBIG: every scheduled day of this payroll is maternity leave (setting pending legal confirmation).')
  }

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
  if (exactSss) {
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
  // R and S (§2 step 3): the exclusions come out of R first, then S; the
  // benefits excess is S, for minimum wage earners too
  let carve = exclusions
  if (isMwe) {
    const exemptBasic = earnings.filter((l) => l.bir === 'basic').reduce((s, l) => s + l.amount, 0)
    carve = Math.max(0, exclusions - Math.max(0, exemptBasic))
    notes.push(
      'Minimum wage earner: statutory minimum wage, holiday, overtime, night differential and hazard pay are exempt from withholding tax.',
    )
  }
  const taxableRegular = round2(Math.max(0, regularLines - carve))
  const taxableSupplementary = round2(Math.max(0, supplementaryLines - Math.max(0, carve - regularLines)) + benefitsExcess)
  const taxableIncome = round2(taxableRegular + taxableSupplementary)

  let withholdingTax: number
  let taxPaidByEmployer = 0
  let whtMethod: WhtMethod
  let whtLabel = 'Withholding Tax'
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
    // what the pay can give after contributions and the other deductions
    // (cash advances come after tax)
    const available = grossPay - deductions.reduce((s, l) => s + l.amount, 0) - otherLines.reduce((s, l) => s + l.amount, 0)
    const capped = capYearEndWithholding(withholding, available)
    withholdingTax = capped.withheld
    taxPaidByEmployer = capped.paidByEmployer
    whtMethod = 'annualized'
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Annualized: taxable compensation for the year ₱${summary.totalTaxable.toLocaleString()} → tax due ₱${summary.taxDue.toLocaleString()}; this payroll withholds the difference from tax already withheld.`,
    )
    if (taxPaidByEmployer > 0) notes.push(yearEndShortfallNote(withholding, withholdingTax, taxPaidByEmployer))
  } else {
    const w = withholdingFor(taxableRegular, taxableSupplementary, params)
    withholdingTax = w.tax
    whtMethod = w.method
    if (w.note) notes.push(w.note)
    if (w.warning) warnings.push(w.warning)
  }
  if (withholdingTax !== 0) deductions.push({ code: 'wht', label: whtLabel, amount: withholdingTax })
  deductions.push(...otherLines)

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
    earnings.filter((l) => l.bir === 'basic' || l.thirteenthBasis).reduce((s, l) => s + l.amount, 0),
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
    taxableRegular,
    taxableSupplementary,
    whtMethod,
    sssEe,
    sssEr,
    sssEcEr,
    sssMpfEe,
    sssMpfEr,
    philhealthEe,
    philhealthEr,
    pagibigEe,
    pagibigEr,
    withholdingTax,
    taxPaidByEmployer,
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
      errors,
      days,
    },
  }
}

// Basis (₱90,000 ceiling): NIRC §32(B)(7)(e), as amended by RA 10963 §9. RR 2-98 §2.78.1(B)(11).
/**
 * 13th month pay run (PD 851): 1/12 of basic salary earned within the
 * calendar year, less any installment already paid. Tax-exempt together
 * with other benefits up to the cap in the annual tax table version
 * (₱90,000); the excess is supplementary compensation of the period it is
 * paid, withheld like any other (withholdingFor).
 */
function computeThirteenthMonth(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, tables, days, runType } = params
  const notes: string[] = []
  const warnings: string[] = []
  if (params.newHireWithoutTaxYear) warnings.push(newHireWarning(params.newHireWithoutTaxYear))
  const errors: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)

  const ytdBasic = params.ytdBasicPay ?? 0
  const alreadyPaid = params.ytdThirteenthPaid ?? 0
  const otherBenefits = params.ytdOtherBenefits ?? 0
  const priorExempt = params.priorThirteenthOtherBenefitsExempt ?? 0
  const gross13 = round2(Math.max(0, ytdBasic / 12 - alreadyPaid))
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

  // SSS on 13th month pay is a setting (spec P2): the month's last regular payroll settles it
  const code13 = payCodeOf('THIRTEENTH_MONTH', params.payCodes ?? PAY_CODES)
  const earnings: PayLine[] = gross13 > 0
    ? [{ code: 'thirteenth', label: '13th Month Pay', amount: gross13, taxable: false, bir: 'thirteenth', payCode: code13.code, sss: code13.sss_include }]
    : []

  let withholdingTax = 0
  let taxPaidByEmployer = 0
  let whtMethod: WhtMethod = 'regular'
  let whtLabel = 'Withholding Tax (13th month excess)'
  if (params.annualization) {
    // Paid after the year's tax was already annualized (last December
    // payroll or final pay): true up the year again so it still reconciles.
    const { withholding, summary } = annualizedWithholding(
      params.annualization.ytd,
      {
        payMonth: params.annualization.payMonth,
        isMwe: employee.isMinimumWageEarner,
        earnings,
        contributionsEe: 0,
        unionDues: 0,
        withholdingTax: 0,
      },
      tables.bir_annual,
      params.annualization.prior,
      params.annualization.peraCredit ?? 0,
    )
    const capped = capYearEndWithholding(withholding, gross13)
    withholdingTax = capped.withheld
    taxPaidByEmployer = capped.paidByEmployer
    whtMethod = 'annualized'
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Paid after this tax year was annualized: tax due for the year ₱${summary.taxDue.toLocaleString()} less tax already withheld.`,
    )
    if (taxPaidByEmployer > 0) notes.push(yearEndShortfallNote(withholding, withholdingTax, taxPaidByEmployer))
  } else {
    // The excess is supplementary compensation, for a minimum wage earner
    // too (Soriano v. Secretary of Finance, G.R. 184450); a 13th month run
    // pays no regular compensation of its own.
    if (taxable13 > 0) {
      notes.push(
        `₱${taxable13.toLocaleString()} of the 13th month pay exceeds the exemption cap and is taxed as supplementary compensation.`,
      )
    }
    const w = withholdingFor(0, taxable13, params, true)
    withholdingTax = w.tax
    whtMethod = w.method
    if (w.note) notes.push(w.note)
    if (w.warning) warnings.push(w.warning)
  }

  const deductions: PayLine[] = []
  if (withholdingTax !== 0) deductions.push({ code: 'wht', label: whtLabel, amount: withholdingTax })

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
    taxableRegular: 0,
    taxableSupplementary: taxable13,
    whtMethod,
    sssEe: 0,
    sssEr: 0,
    sssEcEr: 0,
    sssMpfEe: 0,
    sssMpfEr: 0,
    philhealthEe: 0,
    philhealthEr: 0,
    pagibigEe: 0,
    pagibigEr: 0,
    withholdingTax,
    taxPaidByEmployer,
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
      errors,
      days,
    },
  }
}

/** A new hire's missing previous-employer record (spec T8). */
function newHireWarning(h: { hireDate: string; year: number }): string {
  return `Hired ${shortDate(h.hireDate)}: record under BIR data whether they had another employer earlier in ${h.year} (the figures on their BIR Form 2316). Until then, withholding and the year-end adjustment treat this as their only employer this year.`
}

/** The payslip note when the pay can't cover the year-end shortfall (spec T8). */
function yearEndShortfallNote(shortfall: number, withheld: number, paidByEmployer: number): string {
  return `This pay can cover only ₱${withheld.toLocaleString()} of the year's ₱${round2(shortfall).toLocaleString()} tax shortfall (net pay can't go below zero): the employer pays the remaining ₱${paidByEmployer.toLocaleString()} with the month's 1601-C. It is recorded as an advance to the employee when this payroll is finalized, to settle between employee and employer, and is never withheld as tax from later pay.`
}

/** 1234.5 -> "1,234.50": payslip lines print in PDFs, whose fonts have no peso sign. */
function plainAmount(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-10-06 -> Oct 6 (warnings name dates without depending on the browser's locale). */
function shortDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`
}
