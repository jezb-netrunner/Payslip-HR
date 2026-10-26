// Payroll compliance update of 2026-10-25 (owner's spec, change IDs C1–C10).
// The expected figures are the spec's test vectors.

import { describe, expect, it } from 'vitest'
import { annualizedWithholding, summarizeYear } from './annual'
import { DEFAULT_TABLES } from './defaults'
import { buildAlphalist } from './alphalist'
import { capShortfall, computePayslip } from './engine'
import { remittances1601C } from './remittance'
import { computeWithholdingTax } from './statutory'
import { periodsThisYear, periodWithholding } from './withholding'
import type { DayComputation, DayType, PayLine, PayrollEmployeeInput, PayrollSettingsInput, PeriodInput } from './types'

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
