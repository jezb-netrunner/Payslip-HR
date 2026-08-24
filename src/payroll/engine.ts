// The payroll engine: turns attendance facts + statutory tables + employee
// pay data into a full payslip computation with an auditable trace.
//
// Legal basis implemented here (single-entity PH private sector):
//  - Labor Code premium pay: rest day/special day 130%, special+rest 150%,
//    regular holiday 200%, regular holiday+rest 260%; OT +25% ordinary days,
//    +30% of the day rate on rest days/special days/holidays; night shift
//    differential +10% (10pm–6am).
//  - SSS (RA 11199), PhilHealth (RA 11223), Pag-IBIG (RA 9679) from the
//    versioned tables passed in.
//  - Withholding tax on compensation: BIR revised tables (TRAIN, RR 11-2018
//    as amended), monthly/semi-monthly. Minimum wage earners are exempt.
//  - 13th month pay (PD 851): 1/12 of basic salary earned in the calendar
//    year; tax-exempt together with other benefits up to the statutory cap.

import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax, taxFromBrackets } from './statutory'
import {
  round2,
  type DayComputation,
  type DayType,
  type PayLine,
  type PayrollEmployeeInput,
  type PayrollSettingsInput,
  type PayslipComputation,
  type PeriodInput,
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

export interface ComputePayslipParams {
  employee: PayrollEmployeeInput
  settings: PayrollSettingsInput
  period: PeriodInput
  tables: StatutoryTables
  days: DayComputation[]
  runType: RunType
  /** Basic pay earned so far this calendar year (needed for 13th month runs). */
  ytdBasicPay?: number
  /** Other taxable-cap benefits already granted this year (bonuses etc.). */
  ytdOtherBenefits?: number
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
 * Slice a monthly statutory amount for one pay period so the two halves of a
 * split month sum EXACTLY to the monthly table amount: the first half takes
 * the floor of the half-centavo, the second half takes the remainder.
 */
export function periodShare(
  monthlyAmount: number,
  factor: number,
  half: PeriodInput['half'],
): number {
  if (factor >= 1) return round2(monthlyAmount)
  if (factor <= 0) return 0
  const cents = Math.round(monthlyAmount * 100)
  const first = Math.floor(cents / 2) / 100
  return half === 'first' ? first : round2(monthlyAmount - first)
}

export function computeStatutory(
  statutoryMonthlyBase: number,
  settings: PayrollSettingsInput,
  period: PeriodInput,
  tables: StatutoryTables,
): StatutoryComputation {
  let periodFactor: number
  if (settings.payFrequency === 'monthly' || period.half === 'full') {
    periodFactor = 1
  } else if (settings.contributionTiming === 'split') {
    periodFactor = 0.5
  } else if (settings.contributionTiming === 'first_half') {
    periodFactor = period.half === 'first' ? 1 : 0
  } else {
    periodFactor = period.half === 'second' ? 1 : 0
  }

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
    periodFactor,
  }
}

export function computePayslip(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, period, tables, days, runType } = params
  if (runType === 'thirteenth_month') return computeThirteenthMonth(params)

  const notes: string[] = []
  const warnings: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)
  const perMinute = hourly / 60
  // A run whose period spans the whole month (half === 'full') is computed
  // with monthly semantics even under semi-monthly settings, so basic pay,
  // allowances, contributions and the WHT table all stay consistent.
  const isSemi = settings.payFrequency === 'semi_monthly' && period.half !== 'full'

  if (daily + 0.005 < settings.minimumWageDaily && !employee.isMinimumWageEarner) {
    warnings.push(
      `Derived daily rate ₱${daily.toFixed(2)} is below the configured minimum wage ₱${settings.minimumWageDaily.toFixed(2)}.`,
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

    if (employee.payType === 'monthly') {
      if (worked) {
        const extraMult = DAY_MULT[d.dayType] - builtIn
        const extra = extraMult * hourly * (d.payableMinutes / 60)
        if (d.dayType === 'rest_day') restDayPay += extra
        else if (d.dayType === 'special_day' || d.dayType === 'special_day_rest')
          specialDayPremium += extra
        else if (isRegularHolidayType(d.dayType)) holidayPremium += extra
      } else if (isRegularHolidayType(d.dayType)) {
        unworkedRegularHolidays += 1
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
        unworkedRegularHolidays += 1
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
  let basicPay: number

  if (employee.payType === 'monthly') {
    basicPay = round2(isSemi ? employee.monthlyRate / 2 : employee.monthlyRate)
    earnings.push({ code: 'basic', label: 'Basic Pay', amount: basicPay, taxable: true })
    const absenceDeduction = round2((absentDays + unpaidLeaveDays) * daily)
    if (absenceDeduction > 0) {
      earnings.push({
        code: 'absence',
        label: `Absences (${absentDays + unpaidLeaveDays} day/s)`,
        amount: -absenceDeduction,
        taxable: true,
      })
    }
    if (lateMin > 0) {
      earnings.push({
        code: 'late',
        label: `Tardiness (${lateMin} min)`,
        amount: -round2(lateMin * perMinute),
        taxable: true,
      })
    }
    if (undertimeMin > 0) {
      earnings.push({
        code: 'undertime',
        label: `Undertime (${undertimeMin} min)`,
        amount: -round2(undertimeMin * perMinute),
        taxable: true,
      })
    }
  } else {
    basicPay = round2(dailyBasic)
    earnings.push({
      code: 'basic',
      label: `Basic Pay (${daysWorked} day/s worked${paidLeaveDays ? ` + ${paidLeaveDays} paid leave` : ''})`,
      amount: basicPay,
      taxable: true,
    })
    notes.push('Daily-paid: tardiness/undertime is reflected in payable hours rather than deducted separately.')
  }

  if (otPay > 0)
    earnings.push({ code: 'ot', label: 'Overtime Pay', amount: round2(otPay), hours: round2(otHours), taxable: true })
  if (ndPay > 0)
    earnings.push({ code: 'nd', label: 'Night Differential', amount: round2(ndPay), hours: round2(ndHours), taxable: true })
  if (restDayPay > 0)
    earnings.push({ code: 'restday', label: 'Rest Day Pay', amount: round2(restDayPay), taxable: true })
  if (specialDayPremium > 0)
    earnings.push({ code: 'special', label: 'Special Day Premium', amount: round2(specialDayPremium), taxable: true })
  if (holidayPremium > 0)
    earnings.push({ code: 'holiday', label: 'Holiday Pay', amount: round2(holidayPremium), taxable: true })

  const allowanceFactor = isSemi ? 0.5 : 1
  for (const a of employee.allowances) {
    const amt = round2(a.monthlyAmount * allowanceFactor)
    if (amt === 0) continue
    const taxable = a.taxable && !a.deMinimis
    earnings.push({
      code: 'allowance',
      label: `${a.label}${taxable ? '' : ' (non-taxable)'}`,
      amount: amt,
      taxable,
    })
  }

  const grossPay = round2(earnings.reduce((s, l) => s + l.amount, 0))
  const grossTaxable = round2(
    earnings.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0),
  )

  // ---- statutory deductions ----
  const stat = computeStatutory(statutoryMonthlyBase, settings, period, tables)
  const f = stat.periodFactor
  const share = (monthlyAmount: number) => periodShare(monthlyAmount, f, period.half)
  const sssEe = share(stat.sss.ee)
  const sssMpfEe = share(stat.sss.mpfEe)
  const philhealthEe = share(stat.philhealthEe)
  const pagibigEe = share(stat.pagibigEe)
  const sssEr = share(stat.sss.er)
  const sssMpfEr = share(stat.sss.mpfEr)
  const sssEcEr = share(stat.sss.ecEr)
  const philhealthEr = share(stat.philhealthEr)
  const pagibigEr = share(stat.pagibigEr)

  if (f === 0) {
    notes.push('Statutory contributions are deducted on the other half of the month (per company settings).')
  } else if (f === 0.5) {
    notes.push('Statutory contributions are split evenly across the two payroll periods of the month.')
  }
  notes.push(
    `SSS MSC ₱${stat.sss.msc.toLocaleString()} on statutory monthly base ₱${statutoryMonthlyBase.toLocaleString()}.`,
  )

  const deductions: PayLine[] = []
  if (sssEe > 0) deductions.push({ code: 'sss', label: 'SSS Contribution', amount: sssEe })
  if (sssMpfEe > 0) deductions.push({ code: 'sss_mpf', label: 'SSS MPF (WISP)', amount: sssMpfEe })
  if (philhealthEe > 0) deductions.push({ code: 'philhealth', label: 'PhilHealth Premium', amount: philhealthEe })
  if (pagibigEe > 0) deductions.push({ code: 'pagibig', label: 'Pag-IBIG Contribution', amount: pagibigEe })

  // ---- withholding tax ----
  const taxableIncome = round2(
    Math.max(0, grossTaxable - sssEe - sssMpfEe - philhealthEe - pagibigEe),
  )
  let withholdingTax = 0
  if (employee.isMinimumWageEarner) {
    notes.push('Minimum wage earner: exempt from withholding tax on compensation (incl. OT, ND, holiday pay).')
  } else {
    withholdingTax = computeWithholdingTax(
      taxableIncome,
      isSemi ? 'semi_monthly' : 'monthly',
      tables.bir_wht,
    )
  }
  if (withholdingTax > 0)
    deductions.push({ code: 'wht', label: 'Withholding Tax', amount: withholdingTax })

  // ---- other deductions ----
  let otherDeductionsTotal = 0
  for (const d of employee.extraDeductions) {
    const amt = round2(d.amount)
    if (amt <= 0) continue
    otherDeductionsTotal += amt
    deductions.push({ code: `other:${d.category}`, label: d.label, amount: amt, meta: d.id })
  }
  otherDeductionsTotal = round2(otherDeductionsTotal)

  const totalDeductions = round2(deductions.reduce((s, l) => s + l.amount, 0))
  const netPay = round2(grossPay - totalDeductions)

  // Earned basic = basic net of absence/tardiness/undertime lines. Stored as
  // the payslip's basic_pay because PD 851 counts only "basic salary earned"
  // toward 13th month pay.
  const earnedBasic = round2(
    earnings
      .filter((l) => ['basic', 'absence', 'late', 'undertime'].includes(l.code))
      .reduce((s, l) => s + l.amount, 0),
  )

  if (netPay < 0) warnings.push('Net pay is negative — review deductions for this employee.')
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
    otherDeductionsTotal,
    totalDeductions,
    netPay,
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
 * calendar year. Tax-exempt together with "other benefits" up to the cap in
 * the annual tax table version (₱90,000); the excess is taxed as supplemental
 * compensation at the employee's marginal rate.
 */
function computeThirteenthMonth(params: ComputePayslipParams): PayslipComputation {
  const { employee, settings, tables, days, runType } = params
  const notes: string[] = []
  const warnings: string[] = []
  const { daily, hourly, statutoryMonthlyBase } = deriveRates(employee, settings)

  const ytdBasic = params.ytdBasicPay ?? 0
  const otherBenefits = params.ytdOtherBenefits ?? 0
  const gross13 = round2(ytdBasic / 12)
  const cap = tables.bir_annual.other_benefits_exemption_cap
  const exemptRemaining = Math.max(0, cap - otherBenefits)
  const taxable13 = round2(Math.max(0, gross13 - exemptRemaining))

  notes.push(`13th month = 1/12 of YTD basic pay ₱${ytdBasic.toLocaleString()} (PD 851).`)
  notes.push(
    `Tax-exempt cap for 13th month + other benefits: ₱${cap.toLocaleString()}; other benefits already granted: ₱${otherBenefits.toLocaleString()}.`,
  )
  if (ytdBasic === 0) warnings.push('YTD basic pay is zero — no finalized payslips found for this year.')

  const earnings: PayLine[] = [
    { code: 'thirteenth', label: '13th Month Pay', amount: gross13, taxable: false },
  ]

  let withholdingTax = 0
  if (taxable13 > 0 && !employee.isMinimumWageEarner) {
    // Supplemental compensation: marginal tax = tax(regular + excess) - tax(regular)
    const stat = computeStatutory(statutoryMonthlyBase, { ...settings, payFrequency: 'monthly' }, { start: '', end: '', half: 'full' }, tables)
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
  if (withholdingTax > 0)
    deductions.push({ code: 'wht', label: 'Withholding Tax (13th month excess)', amount: withholdingTax })

  const totalDeductions = round2(deductions.reduce((s, l) => s + l.amount, 0))

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
    basicPay: gross13,
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
    otherDeductionsTotal: 0,
    totalDeductions,
    netPay: round2(gross13 - totalDeductions),
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
