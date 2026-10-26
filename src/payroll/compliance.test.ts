// Payroll compliance update of 2026-10-25 (owner's spec, change IDs C1–C10).
// The expected figures are the spec's test vectors.

import { describe, expect, it } from 'vitest'
import { annualizedWithholding, summarizeYear } from './annual'
import { DEFAULT_TABLES } from './defaults'
import { annexFCsv, buildAlphalist, form2316Items, FORM_2316_LABELS } from './alphalist'
import { capShortfall, computePayslip, holidayPayExemptProblem, sssCompensation, type MaternityContext } from './engine'
import { eachDate, endOfMonth } from '../lib/manila'
import { remittances1601C } from './remittance'
import { computeSss, computeWithholdingTax } from './statutory'
import { periodsThisYear, periodWithholding } from './withholding'
import { philhealthNgFor, philhealthNgProblem } from './philhealth'
import { filingCalendar, type DueDate } from './dueDates'
import { round2, type DayComputation, type DayType, type PayLine, type PayrollEmployeeInput, type PayrollSettingsInput, type PeriodInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 313,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'weekly',
  minimumWageDaily: 700,
}
const mwe: PayrollEmployeeInput = {
  id: 'm1',
  name: 'Ben Cruz',
  payType: 'daily',
  monthlyRate: 0,
  dailyRate: 700,
  isMinimumWageEarner: true,
  schedule: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const week: PeriodInput = { start: '2026-11-02', end: '2026-11-08', index: 1, count: 4 }

/** One day worked 8 hours (plus `otMinutes` of overtime). */
function workday(date: string, dayType: DayType, otMinutes = 0): DayComputation {
  return {
    date,
    dayType,
    scheduled: dayType === 'regular' || dayType === 'regular_holiday' || dayType === 'special_day',
    workedMinutes: 480 + otMinutes,
    payableMinutes: 480,
    expectedMinutes: 480,
    otMinutes,
    nightDiffMinutes: 0,
    ndOtMinutes: 0,
    lateMinutes: 0,
    undertimeMinutes: 0,
    absent: false,
    onPaidLeave: false,
    onUnpaidLeave: false,
  }
}

const sum = (lines: PayLine[]) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100

function oneDay(day: DayComputation, s: PayrollSettingsInput = settings, employee = mwe) {
  const slip = computePayslip({ employee, settings: s, period: week, tables: DEFAULT_TABLES, days: [day], runType: 'regular' })
  return {
    slip,
    pay: sum(slip.earnings),
    exempt: sum(slip.earnings.filter((l) => !l.taxable)),
    taxable: sum(slip.earnings.filter((l) => l.taxable)),
  }
}

describe('C1: an MWE pays tax on rest-day and special-day premiums', () => {
  it.each([
    ['rest day', 'rest_day', 910, 700, 210],
    ['special day', 'special_day', 910, 700, 210],
    ['special day on a rest day', 'special_day_rest', 1050, 700, 350],
    ['regular holiday, worked', 'regular_holiday', 1400, 1400, 0],
    ['regular holiday on a rest day, worked', 'regular_holiday_rest', 1820, 1400, 420],
  ] as const)('%s: pay %d = exempt %d + taxable %d', (_, dayType, pay, exempt, taxable) => {
    const r = oneDay(workday('2026-11-07', dayType))
    expect(r.pay).toBe(pay)
    expect(r.exempt).toBe(exempt)
    expect(r.taxable).toBe(taxable)
  })

  it('1 overtime hour on a rest day is exempt in full', () => {
    const r = oneDay(workday('2026-11-07', 'rest_day', 60))
    const ot = r.slip.earnings.find((l) => l.bir === 'overtime')
    expect(ot).toMatchObject({ amount: 147.88, taxable: false })
    expect(r.taxable).toBe(210) // only the rest-day premium
  })

  it('labels the taxable premium as premium pay of a minimum wage earner (2316 item 51)', () => {
    const r = oneDay(workday('2026-11-07', 'special_day_rest'))
    expect(r.slip.earnings.find((l) => l.taxable)).toMatchObject({ bir: 'premium', amount: 350 })
    const year = summarizeYear(
      [{ payMonth: '2026-11-01', isMwe: true, earnings: r.slip.earnings, contributionsEe: 0, unionDues: 0, withholdingTax: 0 }],
      DEFAULT_TABLES.bir_annual,
    )
    expect(year.mweBasic).toBe(700)
    expect(year.taxablePremiumMwe).toBe(350)
    expect(year.totalTaxablePresent).toBe(350)
  })

  it('keeps the extra 30% of a regular holiday on a rest day exempt when the client sets it so (O1)', () => {
    const r = oneDay(workday('2026-11-07', 'regular_holiday_rest'), { ...settings, mweRhRestdayPremiumTaxable: false })
    expect(r.pay).toBe(1820)
    expect(r.exempt).toBe(1820)
  })

  it('splits a monthly-paid MWE’s rest-day work into the minimum wage and the taxable premium', () => {
    const monthlyMwe = { ...mwe, payType: 'monthly' as const, monthlyRate: 18258.33, dailyRate: 0 } // 700 a day at 313 days
    const r = oneDay(workday('2026-11-08', 'rest_day'), settings, monthlyMwe)
    const restDay = r.slip.earnings.filter((l) => l.code.startsWith('restday'))
    expect(restDay.map((l) => [l.bir, l.amount, l.taxable])).toEqual([
      ['basic', 700, false],
      ['premium', 210, true],
    ])
    // the rest day's wage is not basic salary for the 13th month (unchanged rule)
    expect(r.slip.basicPay).toBe(r.slip.earnings.find((l) => l.code === 'basic')?.amount)
  })

  it('leaves a non-MWE’s premium pay as it was (taxable holiday and premium pay)', () => {
    const r = oneDay(workday('2026-11-07', 'rest_day'), settings, { ...mwe, isMinimumWageEarner: false })
    expect(r.slip.earnings.map((l) => [l.code, l.bir, l.amount])).toEqual([
      ['basic', 'basic', 700],
      ['restday', 'holiday', 210],
    ])
  })

  it('exempts an MWE’s hazard pay only with the hazardous-assignment certification on file', () => {
    const hazard = { ...mwe, allowances: [{ label: 'Hazard pay', amount: 500, category: 'hazard' as const, basis: 'per_period' as const }] }
    const uncertified = oneDay(workday('2026-11-04', 'regular'), settings, hazard)
    expect(uncertified.slip.earnings.find((l) => l.bir === 'hazard')).toMatchObject({ amount: 500, taxable: true })
    const certified = oneDay(workday('2026-11-04', 'regular'), settings, { ...hazard, hazardCertificationRef: 'DOLE-RO-CAR 2026-118' })
    expect(certified.slip.earnings.find((l) => l.bir === 'hazard')).toMatchObject({ amount: 500, taxable: false })
    // the 2316 puts uncertified hazard pay of an MWE under taxable hazard pay (item 49)
    const year = summarizeYear(
      [{ payMonth: '2026-11-01', isMwe: true, earnings: uncertified.slip.earnings, contributionsEe: 0, unionDues: 0, withholdingTax: 0 }],
      DEFAULT_TABLES.bir_annual,
    )
    expect(year.mweHazard).toBe(0)
    expect(year.taxableHazard).toBe(500)
  })
})

describe('C2: withholding on supplementary pay', () => {
  const monthlyTable = DEFAULT_TABLES.bir_wht.monthly

  it('WHT-1: the bracket of the regular pay applies to regular + supplementary', () => {
    expect(periodWithholding({ regular: 60000, supplementary: 20000, brackets: monthlyTable })).toEqual({ tax: 11208.4, method: 'supplementary' })
    // the old method ran the total through the table
    expect(computeWithholdingTax(80000, 'monthly', DEFAULT_TABLES.bir_wht)).toBe(11875.05)
  })

  /** A year of monthly payrolls; returns each month's withholding. */
  function year(months: { regular: number; supplementary?: number }[], prior = { taxable: 0, withheld: 0, from: 1 }) {
    let taxableBefore = prior.taxable
    let withheldBefore = prior.withheld
    let cumulative = prior.taxable > 0
    return months.map((m, i) => {
      const r = periodWithholding({
        regular: m.regular,
        supplementary: m.supplementary ?? 0,
        brackets: monthlyTable,
        taxYear: { taxableBefore, withheldBefore, periods: prior.from + i, cumulative },
      })
      taxableBefore += m.regular + (m.supplementary ?? 0)
      withheldBefore += r.tax
      cumulative ||= r.method === 'cumulative_average'
      return r.tax
    })
  }

  it('WHT-2: zero-bracket regular pay with supplementary pay switches to the cumulative average for the year', () => {
    const months = Array.from({ length: 11 }, (_, i) => ({ regular: 18000, supplementary: i === 5 ? 30000 : 0 }))
    const taxes = year(months)
    expect(taxes.slice(0, 5)).toEqual([0, 0, 0, 0, 0])
    expect(taxes[5]).toBe(1950.3)
    expect(taxes.slice(6)).toEqual([0, 0, 0, 0, 0])
    // year-end: 246,000 taxable for the year owes no tax: the 1,950.30 is refunded
    const facts = [...months, { regular: 18000, supplementary: 0 }].map((m, i) => ({
      payMonth: `2026-${String(i + 1).padStart(2, '0')}-01`,
      isMwe: false,
      earnings: [{ amount: m.regular + m.supplementary, bir: 'basic' as const, taxable: true }],
      contributionsEe: 0,
      unionDues: 0,
      withholdingTax: taxes[i] ?? 0,
    }))
    const { withholding, summary } = annualizedWithholding(facts.slice(0, 11), facts[11], DEFAULT_TABLES.bir_annual)
    expect(summary.totalTaxable).toBe(246000)
    expect(summary.taxDue).toBe(0)
    expect(withholding).toBe(-1950.3)
  })

  it('WHT-3: supplementary pay at least the regular pay switches to the cumulative average', () => {
    const taxes = year([{ regular: 25000 }, { regular: 25000 }, { regular: 25000, supplementary: 30000 }, { regular: 25000 }])
    expect(taxes).toEqual([625.05, 625.05, 5375.1, 375])
  })

  it('WHT-4: an employee with an earlier employer this year is on the cumulative average from the start', () => {
    const taxes = year([{ regular: 35000 }, { regular: 35000 }], { taxable: 180000, withheld: 8250.3, from: 7 })
    expect(taxes).toEqual([2125.03, 2125.07])
  })

  it('counts the payroll periods from 1 January or the first employment this year', () => {
    expect(periodsThisYear('monthly', '2026-01-01', '2026-07-31')).toBe(7)
    expect(periodsThisYear('semi_monthly', '2026-01-01', '2026-06-15')).toBe(11)
    expect(periodsThisYear('semi_monthly', '2026-03-16', '2026-03-31')).toBe(1)
    expect(periodsThisYear('weekly', '2026-01-01', '2026-01-18')).toBe(3)
  })

  it('uses the method in the payslip: the default for a bonus beside regular pay, the trace says which', () => {
    const employee: PayrollEmployeeInput = { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 60000, dailyRate: 0, oneTimeEarnings: [{ label: 'Commission', amount: 20000, category: 'overtime' }] }
    const slip = computePayslip({
      employee,
      settings: { ...settings, payFrequency: 'monthly', workingDaysDivisor: 261 },
      period: { start: '2026-11-01', end: '2026-11-30', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      taxYear: { taxableBefore: 500000, withheldBefore: 90000, periods: 11, cumulative: false },
    })
    expect(slip.trace.tax).toMatchObject({ method: 'supplementary', supplementary: 20000 })
    expect(slip.trace.tax?.regular).toBe(slip.taxableIncome - 20000)
  })
})

describe('C3: year-end adjustment, refunds, separations', () => {
  it('YEA-1: withholds the shortfall up to the pay after contributions; the employer pays the rest', () => {
    expect(capShortfall(25000, 18500)).toEqual({ withheld: 18500, advanced: 6500 })
    expect(capShortfall(25000, 30000)).toEqual({ withheld: 25000, advanced: 0 })
    expect(capShortfall(-1200, 18500)).toEqual({ withheld: -1200, advanced: 0 }) // a refund is never capped
  })

  it('YEA-1 in the payslip: full annual tax withheld on the 2316, net pay 0, receivable recorded', () => {
    const employee: PayrollEmployeeInput = { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 20000, dailyRate: 0 }
    // the year so far: 600,000 taxable with nothing withheld (an under-withheld year)
    const ytd = Array.from({ length: 11 }, (_, i) => ({
      payMonth: `2026-${String(i + 1).padStart(2, '0')}-01`,
      isMwe: false,
      earnings: [{ amount: 600000 / 11, bir: 'basic' as const, taxable: true }],
      contributionsEe: 0,
      unionDues: 0,
      withholdingTax: 0,
    }))
    const slip = computePayslip({
      employee,
      settings: { ...settings, payFrequency: 'monthly', workingDaysDivisor: 261 },
      period: { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      annualization: { payMonth: '2026-12-01', ytd },
    })
    const contributions = slip.sssEe + slip.sssMpfEe + slip.philhealthEe + slip.pagibigEe
    const advance = slip.deductions.find((l) => l.code === 'tax_advance')
    expect(slip.withholdingTax).toBeGreaterThan(slip.grossPay - contributions)
    expect(advance?.amount).toBe(-Math.round((slip.withholdingTax - (slip.grossPay - contributions)) * 100) / 100)
    expect(advance?.label).toBe('Tax advanced by employer (receivable)')
    expect(slip.netPay).toBe(0)
    expect(slip.trace.warnings.some((w) => w.includes('Tax advanced by employer'))).toBe(true)
  })

  it('YEA-1 with a loan installment: the tax takes the pay first, the installment waits', () => {
    const ytd = Array.from({ length: 11 }, (_, i) => ({
      payMonth: `2026-${String(i + 1).padStart(2, '0')}-01`,
      isMwe: false,
      earnings: [{ amount: 600000 / 11, bir: 'basic' as const, taxable: true }],
      contributionsEe: 0,
      unionDues: 0,
      withholdingTax: 0,
    }))
    const december = (loan: number) =>
      computePayslip({
        employee: {
          ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 20000, dailyRate: 0,
          extraDeductions: loan ? [{ id: 'loan-1', label: 'Company loan', category: 'company_loan', amount: loan, balance: 20000 }] : [],
        },
        settings: { ...settings, payFrequency: 'monthly', workingDaysDivisor: 261 },
        period: { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 },
        tables: DEFAULT_TABLES,
        days: [],
        runType: 'regular',
        annualization: { payMonth: '2026-12-01', ytd },
      })
    const advance = (slip: ReturnType<typeof december>) => slip.deductions.find((l) => l.code === 'tax_advance')?.amount
    const withLoan = december(5000)
    // up to the pay after contributions, as without the loan
    expect(advance(withLoan)).toBe(advance(december(0)))
    expect(withLoan.deductions.some((l) => l.code === 'other:company_loan')).toBe(false)
    expect(withLoan.otherDeductionsTotal).toBe(0)
    expect(withLoan.netPay).toBe(0)
    expect(withLoan.trace.warnings.some((w) => w.startsWith('Company loan: ₱5,000.00 could not be deducted') && w.includes('stays in the balance'))).toBe(true)
  })

  it('YEA-2: a refund reduces the 1601-C of the month it is paid; the unused part carries to later months', () => {
    const months = remittances1601C([
      { month: '2027-01-01', withheld: 800, refunds: 1200 },
      { month: '2027-02-01', withheld: 1000, refunds: 0 },
    ])
    expect(months[0]).toMatchObject({ toRemit: 0, carryOut: 400 })
    expect(months[1]).toMatchObject({ carryIn: 400, toRemit: 600, carryOut: 0 })
  })

  it('SEP-1: a separation before December settles the tax on the annual table without projecting; the 2316 is dated the last pay', () => {
    const fact = (month: string, taxable: number, withheld: number, payDate?: string) => ({
      payMonth: `${month}-01`,
      payDate,
      isMwe: false,
      earnings: [{ amount: taxable, bir: 'basic' as const, taxable: true }],
      contributionsEe: 0,
      unionDues: 0,
      withholdingTax: withheld,
    })
    const ytd = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m) => fact(m, 60000, 2600))
    const last = fact('2026-06', 30000, 0, '2026-06-15')
    const { withholding, summary } = annualizedWithholding(ytd, last, DEFAULT_TABLES.bir_annual)
    expect(summary.totalTaxable).toBe(330000)
    expect(summary.taxDue).toBe(12000)
    expect(withholding).toBe(-1000)
    const [row] = buildAlphalist({
      year: 2026,
      entity: { minimum_wage_region: 'CAR', working_days_divisor: 261 } as never,
      employees: [{ id: 'e', hire_date: '2020-01-01', separation_date: '2026-06-15', separation_reason: 'resignation', employment_status: 'regular', pay_type: 'monthly', monthly_rate: 60000, daily_rate: 0, last_name: 'A', first_name: 'B', tin: '1', birth_date: '1990-01-01', address: 'x', zip_code: '1' } as never],
      payslips: [...ytd.map((f, i) => ({ employee_id: 'e', fact: { ...f, payDate: `2026-0${i + 1}-30` } })), { employee_id: 'e', fact: { ...last, withholdingTax: withholding } }],
      taxYears: [],
      annual: DEFAULT_TABLES.bir_annual,
    })
    expect(row.issuedOn).toBe('2026-06-15')
    expect(row.summary.variance).toBe(0)
  })
})

describe('C4: de minimis ceilings (RR 29-2025) and leave converted to cash', () => {
  const employee: PayrollEmployeeInput = { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 30000, dailyRate: 0 }
  const monthly = { ...settings, payFrequency: 'monthly' as const, workingDaysDivisor: 261 }
  const november = { start: '2026-11-01', end: '2026-11-30', index: 1, count: 1 }
  const run = (over: Partial<PayrollEmployeeInput>, s = monthly, deMinimisUsed?: Parameters<typeof computePayslip>[0]['deMinimisUsed']) =>
    computePayslip({ employee: { ...employee, ...over }, settings: s, period: november, tables: DEFAULT_TABLES, days: [], runType: 'regular', deMinimisUsed })
  const rice = (amount: number) => ({ allowances: [{ label: 'Rice subsidy', amount, category: 'de_minimis' as const, basis: 'monthly' as const, deMinimisKind: 'rice' as const }] })
  const split = (slip: ReturnType<typeof run>) => ({
    exempt: sum(slip.earnings.filter((l) => l.bir === 'de_minimis')),
    excess: sum(slip.earnings.filter((l) => l.code === 'de_minimis_excess')),
  })

  it('rice subsidy 2,500 in a month: exempt 2,500', () => {
    expect(split(run(rice(2500)))).toEqual({ exempt: 2500, excess: 0 })
  })

  it('rice subsidy 2,700: exempt 2,500, the 200 above the ceiling is taxable', () => {
    const slip = run(rice(2700))
    expect(split(slip)).toEqual({ exempt: 2500, excess: 200 })
    expect(slip.earnings.find((l) => l.code === 'de_minimis_excess')).toMatchObject({ taxable: true, bir: 'other_supplementary' })
  })

  it('counts what earlier payrolls of the month already paid under the same ceiling', () => {
    expect(split(run(rice(1500), monthly, { rice: { month: 1500, semester: 1500, year: 1500 } }))).toEqual({ exempt: 1000, excess: 500 })
  })

  it('a client granting 15 VL days: 14 unused days converted → 12 days de minimis, 2 taxable', () => {
    const conversion = { oneTimeEarnings: [{ label: 'Unused VL converted (14 days)', amount: 14 * 1149.43, category: 'de_minimis' as const, leaveDays: 14 }] }
    const slip = run(conversion, { ...monthly, paidVlDaysPerYear: 15 })
    const dm = slip.earnings.find((l) => l.bir === 'de_minimis')
    const taxable = slip.earnings.find((l) => l.code === 'de_minimis_excess')
    expect(dm).toMatchObject({ leaveDays: 12, amount: 13793.16 })
    expect(taxable).toMatchObject({ leaveDays: 2, amount: 2298.86, taxable: true })
  })

  it('a SIL-only client: 5 SIL days converted to cash are all taxable (O7)', () => {
    const conversion = { oneTimeEarnings: [{ label: 'Unused SIL converted (5 days)', amount: 5747.15, category: 'de_minimis' as const, leaveDays: 5 }] }
    const slip = run(conversion, { ...monthly, paidVlDaysPerYear: 0 })
    expect(slip.earnings.filter((l) => l.bir === 'de_minimis')).toHaveLength(0)
    expect(slip.earnings.find((l) => l.code === 'leave_conversion')).toMatchObject({ amount: 5747.15, taxable: true, leaveDays: 5 })
    // the client may treat SIL conversions like VL instead
    const lenient = run(conversion, { ...monthly, paidVlDaysPerYear: 0, silConversionTaxable: false })
    expect(lenient.earnings.find((l) => l.bir === 'de_minimis')).toMatchObject({ amount: 5747.15, leaveDays: 5 })
  })

  it('a benefit not on the de minimis list is taxable', () => {
    const slip = run({ allowances: [{ label: 'Gym allowance', amount: 1000, category: 'de_minimis', basis: 'monthly' }] })
    expect(slip.earnings.find((l) => l.label.startsWith('Gym allowance'))).toMatchObject({ taxable: true, bir: 'other_supplementary' })
    expect(slip.trace.warnings.some((w) => w.includes('not on the de minimis list'))).toBe(true)
  })

  it('caps the overtime meal allowance at 30% of the regional minimum wage per overtime day', () => {
    const meal = { allowances: [{ label: 'OT meal allowance', amount: 300, category: 'de_minimis' as const, basis: 'per_period' as const, deMinimisKind: 'meal_ot' as const }] }
    const day = workday('2026-11-04', 'regular', 120)
    const slip = computePayslip({ employee: { ...employee, ...meal }, settings: monthly, period: november, tables: DEFAULT_TABLES, days: [day], runType: 'regular' })
    expect(split(slip)).toEqual({ exempt: 210, excess: 90 }) // one overtime day × 30% × 700
  })
})

describe('C5: the SSS contribution base is all remuneration of the SSS month', () => {
  const monthlySettings = { ...settings, payFrequency: 'monthly' as const, workingDaysDivisor: 261 }
  const none = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }

  it('SSS-1: includes OT, de minimis and bonuses; excludes the Christmas bonus and allowances subject to liquidation', () => {
    const employee: PayrollEmployeeInput = {
      ...mwe,
      isMinimumWageEarner: false,
      payType: 'monthly',
      monthlyRate: 20000,
      dailyRate: 0,
      allowances: [
        { label: 'Rice subsidy (cash)', amount: 2500, category: 'de_minimis', basis: 'monthly', deMinimisKind: 'rice' },
        { label: 'Transport reimbursement', amount: 3000, category: 'transportation', basis: 'monthly', payItemType: 'liquidated_allowance' },
      ],
      oneTimeEarnings: [
        { label: 'Overtime', amount: 1500, category: 'overtime' },
        { label: 'Performance bonus', amount: 5000, category: 'other_benefits' },
        { label: 'Christmas bonus', amount: 3000, category: 'other_benefits', payItemType: 'christmas_bonus' },
      ],
    }
    const slip = computePayslip({
      employee,
      settings: monthlySettings,
      period: { start: '2026-11-01', end: '2026-11-30', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      monthContributions: { already: none, compensationAlready: 0, closes: true, opens: true },
    })
    expect(sssCompensation(slip.earnings)).toBe(29000)
    expect(slip.trace.notes.some((n) => n.includes('compensation ₱29,000 (MSC ₱29,000'))).toBe(true)
    expect(slip.sssEe + slip.sssMpfEe).toBe(1450)
  })

  it('SSS-2: semi-monthly 14,500 + 14,500: one MSC on 29,000; the month’s deductions add up to the schedule share', () => {
    const employee: PayrollEmployeeInput = { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 29000, dailyRate: 0 }
    const semi = { ...monthlySettings, payFrequency: 'semi_monthly' as const }
    const first = computePayslip({
      employee, settings: semi, period: { start: '2026-11-01', end: '2026-11-15', index: 1, count: 2 }, tables: DEFAULT_TABLES, days: [], runType: 'regular',
      monthContributions: { already: none, compensationAlready: 0, closes: false, opens: true },
    })
    const second = computePayslip({
      employee, settings: semi, period: { start: '2026-11-16', end: '2026-11-30', index: 2, count: 2 }, tables: DEFAULT_TABLES, days: [], runType: 'regular',
      monthContributions: {
        already: { ...none, sssEe: first.sssEe, sssMpfEe: first.sssMpfEe, sssEr: first.sssEr, sssMpfEr: first.sssMpfEr, sssEcEr: first.sssEcEr },
        compensationAlready: sssCompensation(first.earnings),
        closes: true,
        opens: false,
      },
    })
    const msc = computeSss(29000, DEFAULT_TABLES.sss)
    expect(sssCompensation(first.earnings) + sssCompensation(second.earnings)).toBe(29000)
    expect(round2(first.sssEe + first.sssMpfEe + second.sssEe + second.sssMpfEe)).toBe(round2(msc.ee + msc.mpfEe))
    expect(round2(first.sssEr + first.sssMpfEr + second.sssEr + second.sssMpfEr)).toBe(round2(msc.er + msc.mpfEr))
  })

  it('SSS-3: December basic 25,000 + 13th month 25,000: base 50,000 → the schedule maximum (O2, default on)', () => {
    const employee: PayrollEmployeeInput = { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 25000, dailyRate: 0 }
    const thirteenth = [{ code: 'thirteenth', label: '13th Month Pay', amount: 25000, bir: 'thirteenth' as const, taxable: false }]
    const december = (s: PayrollSettingsInput) =>
      computePayslip({
        employee, settings: s, period: { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 }, tables: DEFAULT_TABLES, days: [], runType: 'regular',
        monthContributions: { already: none, compensationAlready: sssCompensation(thirteenth, s), closes: true, opens: false },
      })
    const max = computeSss(DEFAULT_TABLES.sss.msc_max, DEFAULT_TABLES.sss)
    const withThirteenth = december(monthlySettings)
    expect(withThirteenth.trace.notes.some((n) => n.includes('compensation ₱50,000 (MSC ₱35,000'))).toBe(true)
    expect(withThirteenth.sssEe + withThirteenth.sssMpfEe).toBe(round2(max.ee + max.mpfEe))
    // a client that leaves the 13th month out of SSS compensation
    const without = december({ ...monthlySettings, sssInclude13thMonth: false })
    expect(without.trace.notes.some((n) => n.includes('compensation ₱25,000 (MSC ₱25,000'))).toBe(true)
  })
})

describe('C6: maternity leave contributions, employee shares and the DOLE exemption', () => {
  const ana: PayrollEmployeeInput = { ...mwe, id: 'ana', isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 30000, dailyRate: 0, schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 } }
  const monthlySettings = { ...settings, payFrequency: 'monthly' as const, workingDaysDivisor: 261 }
  const none = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }
  const month = (mm: string) => ({ start: `2026-${mm}-01`, end: endOfMonth(`2026-${mm}-01`), index: 1, count: 1 })
  const leave = { start: '2026-03-01', end: '2026-06-13' }
  const leaveMonths = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']
  /** every day of the month on maternity leave */
  const onLeave = (mm: string): DayComputation[] =>
    eachDate(`2026-${mm}-01`, endOfMonth(`2026-${mm}-01`)).map((d) => ({
      ...workday(d, 'regular'),
      scheduled: true,
      workedMinutes: 0,
      payableMinutes: 0,
      onPaidLeave: true,
      leaveCode: 'ML',
      leaveStart: leave.start,
    }))
  const maternity = (thisMonth: string, over: Partial<MaternityContext> = {}): MaternityContext => ({
    leaveStart: leave.start,
    months: leaveMonths.map((m) => ({ month: m, charged: 0, fundedByPay: 0, prepaidUsed: 0, covered: 0 })),
    thisMonth,
    ...over,
  })
  const pay = (mm: string, days: DayComputation[], m?: MaternityContext, employee = ana, s: PayrollSettingsInput = monthlySettings) =>
    computePayslip({
      employee, settings: s, period: month(mm), tables: DEFAULT_TABLES, days, runType: 'regular',
      monthContributions: { already: none, compensationAlready: 0, closes: true, opens: true },
      maternity: m,
    })
  const contributions = (p: ReturnType<typeof pay>) => [p.sssEe, p.sssMpfEe, p.sssEr, p.sssMpfEr, p.sssEcEr, p.philhealthEe, p.philhealthEr, p.pagibigEe, p.pagibigEr]

  it('MAT-1: a leave month without regular pay contributes the usual SSS, PhilHealth and Pag-IBIG', () => {
    const february = pay('02', [])
    const april = pay('04', onLeave('04'), maternity('2026-04-01'))
    expect(april.grossPay).toBe(0)
    expect(contributions(april)).toEqual(contributions(february))
    // no maternity pay yet: the employee's share waits for it, net pay stays at zero
    const ee = round2(april.sssEe + april.sssMpfEe + april.philhealthEe + april.pagibigEe)
    expect(april.deductions.find((l) => l.code === 'ee_pending')).toMatchObject({ amount: -ee })
    expect(april.netPay).toBe(0)
  })

  it('deducts the employee shares of all leave months from the maternity pay; the leave months then use them', () => {
    const benefits = [
      { label: 'SSS maternity benefit', amount: 70000, category: 'other_non_taxable' as const, benefit: 'sss_maternity' as const },
      { label: 'Salary differential', amount: 35000, category: 'other_non_taxable' as const, benefit: 'maternity_differential' as const },
    ]
    // paid in February, before the leave: every leave month's share is held as prepaid
    const february = pay('02', [], maternity('2026-02-01'), { ...ana, oneTimeEarnings: benefits })
    const line = february.deductions.find((l) => l.code === 'maternity_contributions')
    const usual = round2(february.sssEe + february.sssMpfEe + february.philhealthEe + february.pagibigEe)
    expect(line?.covers).toEqual(leaveMonths.map((m) => ({ month: m, amount: usual })))
    expect(line?.amount).toBe(round2(usual * 4))
    // April then takes its share from what was prepaid
    const april = pay('04', onLeave('04'), maternity('2026-04-01', {
      months: leaveMonths.map((m) => ({ month: m, charged: 0, fundedByPay: 0, prepaidUsed: 0, covered: usual })),
    }))
    expect(april.deductions.find((l) => l.code === 'ee_prepaid')).toMatchObject({ amount: -usual, label: 'Employee contributions paid from the maternity pay' })
    expect(april.netPay).toBe(0)
  })

  it('MAT-2: maternity pay is non-taxable, 2316 item 37, outside the ₱90,000 pool; the 13th month counts the differential only', () => {
    const slip = pay('03', onLeave('03'), maternity('2026-03-01'), {
      ...ana,
      oneTimeEarnings: [
        { label: 'SSS maternity benefit', amount: 70000, category: 'other_non_taxable', benefit: 'sss_maternity' },
        { label: 'Salary differential', amount: 35000, category: 'other_non_taxable', benefit: 'maternity_differential' },
      ],
    })
    expect(slip.taxableIncome).toBe(0)
    const year = summarizeYear(
      [{ payMonth: '2026-03-01', isMwe: false, earnings: slip.earnings, contributionsEe: 0, unionDues: 0, withholdingTax: 0 }],
      DEFAULT_TABLES.bir_annual,
    )
    expect(year.otherNonTaxable).toBe(105000) // item 37
    expect(year.thirteenthOtherBenefits).toBe(0) // the ₱90,000 pool is untouched
    expect(slip.basicPay).toBe(35000) // 13th month base: the differential, not the SSS benefit
  })

  it('MAT-3: a DOLE exemption that ends before the leave starts does not apply; a warning says so', () => {
    const exempt = { ...monthlySettings, maternityDifferentialExemption: { ref: 'DOLE-CAR-2026-0042', validUntil: '2026-12-31' } }
    const january = computePayslip({
      employee: ana, settings: exempt, period: { start: '2027-01-01', end: '2027-01-31', index: 1, count: 1 }, tables: DEFAULT_TABLES, days: [], runType: 'regular',
      maternity: { leaveStart: '2027-01-05', months: [{ month: '2027-01-01', charged: 0, fundedByPay: 0, prepaidUsed: 0, covered: 0 }], thisMonth: '2027-01-01' },
    })
    expect(january.trace.warnings.some((w) => w.includes('valid until Dec 31, 2026') && w.includes('not exempt'))).toBe(true)
  })

  it('O3: a DOLE-exempt client computes the leave months’ shares but does not take them from the maternity pay', () => {
    const exempt = { ...monthlySettings, maternityDifferentialExemption: { ref: 'DOLE-CAR-2026-0042', validUntil: '2026-12-31' } }
    const april = pay('04', onLeave('04'), maternity('2026-04-01'), ana, exempt)
    const ee = round2(april.sssEe + april.sssMpfEe + april.philhealthEe + april.pagibigEe)
    expect(april.deductions.find((l) => l.code === 'ee_collect')).toMatchObject({ amount: -ee, label: 'Employee share to collect (advanced by the employer)' })
    expect(april.trace.warnings.some((w) => w.startsWith('Employee share to collect'))).toBe(true)
    const payout = pay('03', onLeave('03'), maternity('2026-03-01'), { ...ana, oneTimeEarnings: [{ label: 'SSS maternity benefit', amount: 70000, category: 'other_non_taxable', benefit: 'sss_maternity' }] }, exempt)
    expect(payout.deductions.find((l) => l.code === 'maternity_contributions')).toBeUndefined()
  })
})

describe('C7: PhilHealth — the national government pays the employee half for solo parents and PWDs', () => {
  const ana: PayrollEmployeeInput = { ...mwe, id: 'ana', isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 30000, dailyRate: 0 }
  const monthlySettings = { ...settings, payFrequency: 'monthly' as const, workingDaysDivisor: 261 }
  const run = (ng?: 'solo_parent' | 'pwd') =>
    computePayslip({
      employee: { ...ana, philhealthNg: ng }, settings: monthlySettings, period: { start: '2026-11-01', end: '2026-11-30', index: 1, count: 1 },
      tables: DEFAULT_TABLES, days: [], runType: 'regular',
    })
  const soloParent = { ph_ng_type: 'solo_parent' as const, ph_ng_from_month: '2026-11-01', id_number: 'SPIC-2026-0099', id_valid_until: '2027-03-15' }

  it('tagged month (premium 1,500): employee 0, employer 750, NG share 750 not deducted nor remitted', () => {
    expect(philhealthNgFor(soloParent, '2026-11-01')).toBe('solo_parent')
    const slip = run('solo_parent')
    expect([slip.philhealthEe, slip.philhealthEr, slip.philhealthNg]).toEqual([0, 750, 750])
    expect(slip.deductions.some((l) => l.code === 'philhealth')).toBe(false)
  })

  it('the month before ph_ng_from_month: 750 / 750', () => {
    expect(philhealthNgFor(soloParent, '2026-10-01')).toBeUndefined()
    const slip = run(undefined)
    expect([slip.philhealthEe, slip.philhealthEr, slip.philhealthNg]).toEqual([750, 750, 0])
  })

  it('the ID expiry month: 750 / 750 (the last NG month is the month before)', () => {
    expect(philhealthNgFor(soloParent, '2027-02-01')).toBe('solo_parent')
    expect(philhealthNgFor(soloParent, '2027-03-01')).toBeUndefined()
    // a renewed ID continues it
    expect(philhealthNgFor({ ...soloParent, id_valid_until: '2028-03-15' }, '2027-03-01')).toBe('solo_parent')
  })

  it('a solo parent not before October 2026; a PWD from the month the requirements were submitted', () => {
    expect(philhealthNgFor({ ...soloParent, ph_ng_from_month: '2026-09-01' }, '2026-09-01')).toBeUndefined()
    expect(philhealthNgFor({ ph_ng_type: 'pwd', ph_ng_from_month: '2026-08-01', id_number: 'PWD-123', id_valid_until: null }, '2026-08-01')).toBe('pwd')
    expect(philhealthNgProblem('solo_parent', '2026-09-01', 'SPIC-1', '2027-09-01')).toMatch(/not earlier than October 2026/)
    expect(philhealthNgProblem('solo_parent', '2026-10-01', '', '2027-09-01')).toMatch(/Solo Parent ID/)
    expect(philhealthNgProblem('solo_parent', '2026-10-01', 'SPIC-1', '')).toMatch(/valid until/)
    expect(philhealthNgProblem('pwd', '2026-08-01', 'PWD-1', '')).toBe('')
  })
})

describe('C8: holiday pay settings', () => {
  const daily: PayrollEmployeeInput = { ...mwe, id: 'd1', isMinimumWageEarner: false, schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 } }
  const period: PeriodInput = { start: '2026-08-27', end: '2026-08-31', index: 2, count: 2 }
  const rest = (date: string): DayComputation => ({ ...workday(date, 'rest_day'), scheduled: false, workedMinutes: 0, payableMinutes: 0, expectedMinutes: 0 })
  // worked Thursday, absent without pay Friday, the weekend, then Monday's regular holiday
  const week = (holidayWorked: boolean): DayComputation[] => [
    workday('2026-08-27', 'regular'),
    { ...workday('2026-08-28', 'regular'), workedMinutes: 0, payableMinutes: 0, absent: true },
    rest('2026-08-29'),
    rest('2026-08-30'),
    holidayWorked
      ? { ...workday('2026-08-31', 'regular_holiday'), holidayName: 'National Heroes Day' }
      : { ...workday('2026-08-31', 'regular_holiday'), holidayName: 'National Heroes Day', workedMinutes: 0, payableMinutes: 0 },
  ]
  const pay = (s: PayrollSettingsInput, days: DayComputation[]) =>
    computePayslip({ employee: daily, settings: s, period, tables: DEFAULT_TABLES, days, runType: 'regular' })
  const holidayPay = (slip: ReturnType<typeof pay>) => slip.earnings.find((l) => l.code === 'holiday')?.amount ?? 0

  it('default (rule off, O8): an unpaid absence on the workday before does not cost the holiday pay', () => {
    expect(holidayPay(pay(settings, week(false)))).toBe(700)
  })

  it('rule on: no regular holiday pay after an unpaid absence on the workday before', () => {
    const slip = pay({ ...settings, holidayAbsenceRule: true }, week(false))
    expect(holidayPay(slip)).toBe(0)
    expect(slip.trace.warnings.some((w) => w.startsWith('Regular holiday not paid'))).toBe(true)
  })

  it('rule on and the employee worked the holiday: paid as a worked holiday (200%)', () => {
    const slip = pay({ ...settings, holidayAbsenceRule: true }, week(true))
    expect(holidayPay(slip)).toBe(700)
    expect(slip.earnings.find((l) => l.code === 'basic')?.amount).toBe(1400) // Thursday + the holiday's 100%
  })

  it('an exempt retail or service establishment (fewer than 10 workers) pays a regular holiday as an ordinary day', () => {
    const exempt = { ...settings, holidayPayExempt: true }
    expect(holidayPay(pay(exempt, week(false)))).toBe(0)
    const worked = pay(exempt, week(true))
    expect(holidayPay(worked)).toBe(0)
    expect(worked.earnings.find((l) => l.code === 'basic')?.amount).toBe(1400)
    expect(holidayPayExemptProblem({ retailOrService: true, regularWorkers: 9 })).toBe('')
    expect(holidayPayExemptProblem({ retailOrService: true, regularWorkers: 10 })).toMatch(/less than 10/)
    expect(holidayPayExemptProblem({ retailOrService: false, regularWorkers: 3 })).toMatch(/retail or service/)
  })
})

describe('C9: filing due dates', () => {
  const client = { filing: 'manual' as const, efpsGroup: null, philhealthEmployerNo: '01-234567890-3', pagibigDueDay: null }
  const due = (rows: DueDate[], filing: DueDate['filing'], period: string) => rows.find((r) => r.filing === filing && r.period === period)
  const holidays = [{ holiday_date: '2026-11-30', name: 'Bonifacio Day' }]
  const rows = filingCalendar(2026, client, holidays)

  it('1601-C: the 10th of the next month, December on 15 January (manual filing)', () => {
    expect(due(rows, '1601c', '2026-03-01')?.due).toBe('2026-04-10')
    expect(due(rows, '1601c', '2026-12-01')?.due).toBe('2027-01-15')
  })

  it('1601-C on eFPS: 15/14/13/12/11 days after month-end for groups A to E', () => {
    const efps = (g: 'A' | 'B' | 'C' | 'D' | 'E') => due(filingCalendar(2026, { ...client, filing: 'efps', efpsGroup: g }, []), '1601c', '2026-03-01')?.due
    expect(['A', 'B', 'C', 'D', 'E'].map((g) => efps(g as 'A'))).toEqual(['2026-04-15', '2026-04-14', '2026-04-13', '2026-04-12', '2026-04-11'])
  })

  it('SSS: the last day of the month after; PhilHealth by the employer number; Pag-IBIG as the client enters it', () => {
    expect(due(rows, 'sss', '2026-01-01')?.due).toBe('2026-02-28')
    expect(due(rows, 'philhealth', '2026-03-01')).toMatchObject({ from: '2026-04-11', due: '2026-04-15' }) // PEN ends in 3
    expect(due(filingCalendar(2026, { ...client, philhealthEmployerNo: '01-234567890-7' }, []), 'philhealth', '2026-03-01')).toMatchObject({ from: '2026-04-16', due: '2026-04-20' })
    expect(due(rows, 'pagibig', '2026-03-01')?.due).toBe('')
    expect(due(filingCalendar(2026, { ...client, pagibigDueDay: 15 }, []), 'pagibig', '2026-03-01')?.due).toBe('2026-04-15')
  })

  it('the year-end filings: refunds 25 Jan, 2316 to employees and 1604-C 31 Jan, BIR copies and Annex F 28 Feb', () => {
    expect(['refunds', '2316_employees', '1604c', '2316_bir'].map((f) => due(rows, f as DueDate['filing'], '2026-01-01')?.due)).toEqual([
      '2027-01-25', '2027-01-31', '2027-01-31', '2027-02-28',
    ])
  })

  it('a date on a weekend or a holiday is shown with a note, not moved; an extension replaces the date', () => {
    expect(due(rows, '1601c', '2026-09-01')).toMatchObject({ due: '2026-10-10', note: 'Falls on a Saturday' })
    expect(due(rows, 'sss', '2026-10-01')).toMatchObject({ due: '2026-11-30', note: 'Falls on Bonifacio Day' })
    const extended = filingCalendar(2026, client, [], [{ filing: '1601c', period: '2026-03-01', due_date: '2026-04-20', note: 'RMC extension' }])
    expect(due(extended, '1601c', '2026-03-01')).toMatchObject({ due: '2026-04-20', overridden: true, note: 'RMC extension' })
  })
})

describe('C10: BIR outputs', () => {
  const line = (bir: PayLine['bir'], amount: number, taxable = true) => ({ amount, bir, taxable })
  const year = (isMwe: boolean, earnings: { amount: number; bir?: PayLine['bir']; taxable?: boolean }[], contributionsEe = 0) =>
    summarizeYear([{ payMonth: '2026-12-01', isMwe, earnings, contributionsEe, unionDues: 0, withholdingTax: 0 }], DEFAULT_TABLES.bir_annual)

  it('maps every pay item to its 2316 (September 2021 ENCS) item', () => {
    const s = year(false, [
      line('basic', 300000), line('representation', 1000), line('transportation', 2000), line('cola', 3000), line('housing', 4000),
      line('other_taxable', 5000), line('commission', 6000), line('profit_sharing', 7000), line('fees', 8000),
      line('thirteenth', 100000, false), line('hazard', 9000), line('overtime', 10000), line('holiday', 11000), line('night_diff', 12000),
      line('other_supplementary', 13000), line('de_minimis', 2500, false), line('other_non_taxable', 14000, false),
    ], 20000)
    const items = form2316Items(s)
    expect(items[34]).toBe(90000)
    expect(items[35]).toBe(2500)
    expect(items[36]).toBe(20000)
    expect(items[37]).toBe(14000)
    expect(items[38]).toBe(126500)
    expect([items[39], items[40], items[41], items[42], items[43], items[44]]).toEqual([280000, 1000, 2000, 3000, 4000, 5000])
    expect([items[45], items[46], items[47], items[48], items[49], items[50]]).toEqual([6000, 7000, 8000, 10000, 9000, 10000])
    expect(items['51B']).toBe(36000) // holiday + night differential + other supplementary
    expect(items[52]).toBe(s.totalTaxablePresent)
    expect(items[38] + items[52]).toBe(s.gross)
  })

  it('puts an MWE’s exempt pay in items 29–33 and the premium pay in 51A', () => {
    const items = form2316Items(year(true, [line('basic', 180000, false), line('holiday', 5000, false), line('overtime', 4000, false), line('night_diff', 3000, false), line('hazard', 2000, false), line('premium', 1500)]))
    expect([items[29], items[30], items[31], items[32], items[33]]).toEqual([180000, 5000, 4000, 3000, 2000])
    expect(items['51A']).toBe(1500)
    expect(FORM_2316_LABELS['51A']).toBe('Others: Premium pay (MWE)')
  })

  it('exports the certified list of employees qualified for substituted filing (Annex F)', () => {
    const rows = [
      { substitutedFiling: true, employee: { tin: '123-456-789', last_name: 'Cruz', first_name: 'Ana', middle_name: 'Reyes' } },
      { substitutedFiling: false, employee: { tin: '987-654-321', last_name: 'Diaz', first_name: 'Ben', middle_name: null } },
    ]
    const csv = annexFCsv(rows as never, { name: 'Mu Store', tin: '000-111-222-00000' } as never, 2026)
    const body = csv.slice(csv.findIndex((r) => r[0] === 'Seq') + 1)
    expect(body).toEqual([[1, '123-456-789', 'Cruz', 'Ana', 'Reyes']])
    expect(String(csv[0][0])).toMatch(/Certified List of Employees Qualified for Substituted Filing/)
  })
})

describe('every legal value carries its effective date and source', () => {
  it('law.ts', async () => {
    const law = await import('./law')
    const entries = Object.entries(law).flatMap(([group, values]) => Object.entries(values as Record<string, unknown>).map(([k, v]) => [`${group}.${k}`, v] as const))
    expect(entries.length).toBeGreaterThan(20)
    for (const [name, v] of entries) {
      const lv = v as { value: unknown; effectiveFrom: string; source: string }
      expect(lv.value, name).toBeDefined()
      expect(lv.effectiveFrom, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(lv.source.length, name).toBeGreaterThan(5)
    }
  })
})
