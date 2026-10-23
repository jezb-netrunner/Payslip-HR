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
import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax, taxFromBrackets } from './statutory'
import {
  round2,
  type BirBucket,
  type ContributionTiming,
  type DayComputation,
  type DayType,
  type PayLine,
  type PayrollEmployeeInput,
  type PayrollSettingsInput,
  type PayslipComputation,
  type PeriodInput,
  type RoundingInput,
  type RunType,
  type StatutoryComputation,
  type StatutoryTables,
} from './types'

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

function isRegularHolidayType(dayType: DayType): boolean {
  return dayType === 'regular_holiday' || dayType === 'regular_holiday_rest'
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
   * Extras-only final pay: the separation month's contributions already
   * deducted, to flag a month the last payroll never completed (the
   * separation was recorded after that payroll was finalized).
   */
  separationMonth?: { label: string; already: ContributionSet }
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
): StatutoryComputation {
  const sss = computeSss(statutoryMonthlyBase, tables.sss)
  const ph = computePhilHealth(statutoryMonthlyBase, tables.philhealth)
  const pi = computePagibig(statutoryMonthlyBase, tables.pagibig)

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

export function computePayslip(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, period, tables, runType } = params
  if (runType === 'thirteenth_month') return computeThirteenthMonth(params)
  const extrasOnly = params.extrasOnly === true
  const days = extrasOnly ? [] : params.days

  const notes: string[] = []
  const warnings: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)
  const perMinute = hourly / 60
  const isMwe = employee.isMinimumWageEarner

  if (daily + 0.005 < settings.minimumWageDaily && !isMwe) {
    warnings.push(
      `Derived daily rate ₱${daily.toFixed(2)} is below the configured minimum wage ₱${settings.minimumWageDaily.toFixed(2)}.`,
    )
  }

  // A scheduled workday with no time in/out and no approved leave is charged
  // as an absence. That is usually right, but it is also what a day nobody
  // entered looks like (attendance is keyed in by admins): name the dates.
  const absentDates = days.filter((d) => d.absent).map((d) => d.date)
  if (absentDates.length > 0) {
    const shown = absentDates.slice(0, 6).map(shortDate).join(', ') + (absentDates.length > 6 ? ', …' : '')
    warnings.push(
      `${absentDates.length === 1 ? '1 scheduled workday has' : `${absentDates.length} scheduled workdays have`} no time in/out or approved leave and ${absentDates.length === 1 ? 'is' : 'are'} charged as absence (${shown}). If the employee worked, enter the time and recompute.`,
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
  let unworkedRegularHolidays = 0
  let paidUnworkedHolidays = 0

  let otPay = 0
  let ndPay = 0
  let restDayPay = 0
  let specialDayPremium = 0
  let holidayPremium = 0
  let dailyBasic = 0 // daily-paid only

  const stdMin = settings.standardHoursPerDay * 60

  for (const d of days) {
    const worked = d.workedMinutes > 0
    const fraction = Math.min(1, d.payableMinutes / stdMin)
    const builtIn = builtInFor(d.dayType, settings.workingDaysDivisor)
    if (worked) {
      daysWorked += 1
      hoursWorked += d.workedMinutes / 60
      otHours += d.otMinutes / 60
      ndHours += d.nightDiffMinutes / 60
      lateMin += d.lateMinutes
      undertimeMin += d.undertimeMinutes
    }
    if (d.absent) absentDays += 1
    // Leave flags exist on every covered day. Paid-leave credit applies to
    // ordinary scheduled days. Unpaid leave deducts every day the pay basis
    // would otherwise cover: for monthly-paid, any day the divisor deems
    // paid inside the rate (regular days always; holidays; rest days too
    // under divisor 365); for daily-paid it is a statistic on scheduled days
    // (no work already means no pay).
    if (d.onPaidLeave && d.dayType === 'regular') paidLeaveDays += 1
    if (d.onUnpaidLeave && !worked) {
      if (employee.payType === 'monthly' ? builtIn > 0 : d.dayType === 'regular') {
        unpaidLeaveDays += 1
      }
    }
    if (!worked && isRegularHolidayType(d.dayType)) {
      unworkedRegularHolidays += 1
      if (!d.onUnpaidLeave) paidUnworkedHolidays += 1
    }

    if (employee.payType === 'monthly') {
      if (worked) {
        const extraMult = DAY_MULT[d.dayType] - builtIn
        const extra = extraMult * hourly * (d.payableMinutes / 60)
        if (d.dayType === 'rest_day') restDayPay += extra
        else if (d.dayType === 'special_day' || d.dayType === 'special_day_rest')
          specialDayPremium += extra
        else if (isRegularHolidayType(d.dayType)) holidayPremium += extra
      } else if (isRegularHolidayType(d.dayType)) {
        // On leave without pay over the holiday: not entitled — the general
        // unpaid-leave rule above already deducts the day when the monthly
        // rate covers it. Otherwise, a holiday on a day the divisor does NOT
        // deem paid (e.g. a rest day under divisor 261) still earns 100% of
        // the daily wage (Art. 94); a covered day is already paid inside the
        // monthly rate — no extra line, no deduction.
        if (!d.onUnpaidLeave && builtIn === 0) {
          holidayPremium += daily
        }
      }
    } else {
      // daily-paid: no work, no pay — each worked day is paid at its multiplier
      if (worked) {
        dailyBasic += 1.0 * daily * fraction
        const premium = (DAY_MULT[d.dayType] - 1) * daily * fraction
        if (d.dayType === 'rest_day') restDayPay += premium
        else if (d.dayType === 'special_day' || d.dayType === 'special_day_rest')
          specialDayPremium += premium
        else if (isRegularHolidayType(d.dayType)) holidayPremium += premium
      } else if (isRegularHolidayType(d.dayType)) {
        // Unworked regular holiday: 100% of daily wage (Labor Code Art. 94),
        // whether or not it falls on the rest day; forfeited when the
        // employee is on leave without pay over the holiday (simplification
        // of the presence-on-preceding-workday condition).
        if (!d.onUnpaidLeave) holidayPremium += daily
      }
      if (d.onPaidLeave && d.dayType === 'regular') dailyBasic += daily
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

  // ---- earnings ----
  const earnings: PayLine[] = []
  const earn = (code: string, label: string, amount: number, bir: BirBucket, extra: Partial<PayLine> = {}) =>
    earnings.push({ code, label, amount, bir, taxable: isTaxableBucket(bir, isMwe), ...extra })
  let basicPay: number

  if (extrasOnly) {
    basicPay = 0
    notes.push('Final pay after the last paid period: one-time items, tax adjustment and rounding settlement only.')
  } else if (employee.payType === 'monthly') {
    basicPay = allocateMonthly(employee.monthlyRate, period.index, period.count)
    earn('basic', 'Basic Pay', basicPay, 'basic')
    const absenceDeduction = round2((absentDays + unpaidLeaveDays) * daily)
    if (absenceDeduction > 0) {
      earn('absence', `Absences (${absentDays + unpaidLeaveDays} day/s)`, -absenceDeduction, 'basic')
    }
    if (lateMin > 0) {
      earn('late', `Tardiness (${lateMin} min)`, -round2(lateMin * perMinute), 'basic')
    }
    if (undertimeMin > 0) {
      earn('undertime', `Undertime (${undertimeMin} min)`, -round2(undertimeMin * perMinute), 'basic')
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
  if (holidayPremium > 0) earn('holiday', 'Holiday Pay', round2(holidayPremium), 'holiday')

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
    const taxable = isTaxableBucket(a.category, isMwe)
    earn('allowance', `${a.label}${suffix}${taxable ? '' : ' (non-taxable)'}`, amt, a.category)
  }
  for (const e of employee.oneTimeEarnings ?? []) {
    const amt = round2(e.amount)
    if (amt === 0) continue
    earn('adjustment', e.label, amt, e.category, { meta: e.id })
  }

  const grossPay = round2(earnings.reduce((s, l) => s + l.amount, 0))
  const grossTaxable = round2(earnings.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0))

  // ---- statutory deductions ----
  const stat = computeStatutory(statutoryMonthlyBase, settings, period, tables)
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
  const sssEe = share(stat.sss.ee, mc?.already.sssEe)
  const sssMpfEe = share(stat.sss.mpfEe, mc?.already.sssMpfEe)
  const philhealthEe = share(stat.philhealthEe, mc?.already.philhealthEe)
  const pagibigEe = share(stat.pagibigEe, mc?.already.pagibigEe)
  const sssEr = share(stat.sss.er, mc?.already.sssEr)
  const sssMpfEr = share(stat.sss.mpfEr, mc?.already.sssMpfEr)
  const sssEcEr = share(stat.sss.ecEr, mc?.already.sssEcEr)
  const philhealthEr = share(stat.philhealthEr, mc?.already.philhealthEr)
  const pagibigEr = share(stat.pagibigEr, mc?.already.pagibigEr)

  if (extrasOnly) {
    notes.push('No statutory contributions: no compensation for work in this payroll.')
    const sep = params.separationMonth
    if (sep) {
      const a = sep.already
      const short = (due: number, done: number) => Math.max(0, due - done)
      const ee = round2(
        short(stat.sss.ee, a.sssEe) + short(stat.sss.mpfEe, a.sssMpfEe) +
          short(stat.philhealthEe, a.philhealthEe) + short(stat.pagibigEe, a.pagibigEe),
      )
      const er = round2(
        short(stat.sss.er, a.sssEr) + short(stat.sss.mpfEr, a.sssMpfEr) + short(stat.sss.ecEr, a.sssEcEr) +
          short(stat.philhealthEr, a.philhealthEr) + short(stat.pagibigEr, a.pagibigEr),
      )
      if (ee > 0 || er > 0) {
        warnings.push(
          `${sep.label} contributions are short by ₱${ee.toLocaleString()} (employee) and ₱${er.toLocaleString()} (employer): the payroll holding the last day was finalized before the separation was recorded. Reopen and recompute that payroll so it completes the month.`,
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
  if (!extrasOnly) {
    notes.push(
      `SSS MSC ₱${stat.sss.msc.toLocaleString()} on statutory monthly base ₱${statutoryMonthlyBase.toLocaleString()}.`,
    )
  }

  const deductions: PayLine[] = []
  if (sssEe > 0) deductions.push({ code: 'sss', label: 'SSS Contribution', amount: sssEe })
  if (sssMpfEe > 0) deductions.push({ code: 'sss_mpf', label: 'SSS MPF (WISP)', amount: sssMpfEe })
  if (philhealthEe > 0) deductions.push({ code: 'philhealth', label: 'PhilHealth Premium', amount: philhealthEe })
  if (pagibigEe > 0) deductions.push({ code: 'pagibig', label: 'Pag-IBIG Contribution', amount: pagibigEe })

  // ---- other deductions (needed first: union dues are tax-exempt) ----
  const otherLines: PayLine[] = []
  let otherDeductionsTotal = 0
  let unionDues = 0
  for (const d of employee.extraDeductions) {
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
  let taxableIncome: number
  if (isMwe) {
    const exemptBasic = earnings.filter((l) => l.bir === 'basic').reduce((s, l) => s + l.amount, 0)
    taxableIncome = round2(Math.max(0, grossTaxable - Math.max(0, exclusions - Math.max(0, exemptBasic))))
    notes.push(
      'Minimum wage earner: statutory minimum wage, holiday, overtime, night differential and hazard pay are exempt from withholding tax.',
    )
  } else {
    taxableIncome = round2(Math.max(0, grossTaxable - exclusions))
  }

  let withholdingTax: number
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
    withholdingTax = withholding
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Annualized: taxable compensation for the year ₱${summary.totalTaxable.toLocaleString()} → tax due ₱${summary.taxDue.toLocaleString()}; this payroll withholds the difference from tax already withheld.`,
    )
  } else {
    withholdingTax = computeWithholdingTax(taxableIncome, WHT_TABLE[settings.payFrequency], tables.bir_wht)
    if (withholdingTax > 0) notes.push(`Withholding tax from the ${FREQUENCY_LABEL[settings.payFrequency]} BIR table.`)
  }
  if (withholdingTax !== 0) deductions.push({ code: 'wht', label: whtLabel, amount: withholdingTax })
  deductions.push(...otherLines)

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
    earnings.filter((l) => l.bir === 'basic').reduce((s, l) => s + l.amount, 0),
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
      days,
    },
  }
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

  const earnings: PayLine[] = gross13 > 0
    ? [{ code: 'thirteenth', label: '13th Month Pay', amount: gross13, taxable: false, bir: 'thirteenth' }]
    : []

  let withholdingTax = 0
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
    withholdingTax = withholding
    whtLabel = withholding < 0 ? 'Tax Refund (year-end adjustment)' : 'Withholding Tax (annualized)'
    notes.push(
      `Paid after this tax year was annualized: tax due for the year ₱${summary.taxDue.toLocaleString()} less tax already withheld.`,
    )
  } else if (taxable13 > 0 && !employee.isMinimumWageEarner) {
    // Supplemental compensation: marginal tax = tax(regular + excess) - tax(regular)
    const stat = computeStatutory(
      statutoryMonthlyBase,
      { ...settings, payFrequency: 'monthly' },
      { start: '', end: '', index: 1, count: 1 },
      tables,
    )
    const monthlyTaxable = Math.max(
      0,
      statutoryMonthlyBase - stat.sss.ee - stat.sss.mpfEe - stat.philhealthEe - stat.pagibigEe,
    )
    withholdingTax = round2(
      taxFromBrackets(monthlyTaxable + taxable13, tables.bir_wht.monthly) -
        taxFromBrackets(monthlyTaxable, tables.bir_wht.monthly),
    )
    notes.push(
      `₱${taxable13.toLocaleString()} of the 13th month pay exceeds the exemption cap and is taxed as supplemental compensation.`,
    )
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
    },
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-10-06 -> Oct 6 (warnings name dates without depending on the browser's locale). */
function shortDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`
}
