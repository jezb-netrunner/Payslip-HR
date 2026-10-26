import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { allocateMonthly, applyNetPayRounding, computePayslip, contributionShare } from './engine'
import type { PayrollEmployeeInput, PayrollSettingsInput, PeriodInput, TimeEntryLite } from './types'

// ---- weekly-paid, daily-rated minimum wage earner (the cash-payroll case) ----

const weeklySettings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 313, // 6-day work week
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'weekly',
  minimumWageDaily: 755,
}

const mwe: PayrollEmployeeInput = {
  id: 'w1',
  name: 'Ana Reyes',
  payType: 'daily',
  monthlyRate: 0,
  dailyRate: 755,
  isMinimumWageEarner: true,
  schedule: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}

// Mon Oct 5 – Sun Oct 11, 2026, paid Fri Oct 16: the 3rd of 5 Friday paydays in October.
const week: PeriodInput = { start: '2026-10-05', end: '2026-10-11', index: 3, count: 5 }
const WEEK_DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']

/** Manila 08:00–17:00 = 00:00Z–09:00Z. */
function shift(date: string): TimeEntryLite {
  return { work_date: date, clock_in: `${date}T00:00:00Z`, clock_out: `${date}T09:00:00Z` }
}

function weekDays(entries: TimeEntryLite[]) {
  return computeAttendance({
    periodStart: week.start,
    periodEnd: week.end,
    schedule: mwe.schedule,
    standardHoursPerDay: 8,
    gracePeriodMinutes: 0,
    entries,
    holidays: [],
    approvedLeaves: [],
  })
}

describe('weekly payroll: daily-paid minimum wage earner', () => {
  const slip = computePayslip({
    employee: mwe,
    settings: weeklySettings,
    period: week,
    tables: DEFAULT_TABLES,
    days: weekDays(WEEK_DAYS.map(shift)),
    runType: 'regular',
  })

  it('pays the six days worked', () => {
    expect(slip.daysWorked).toBe(6)
    expect(slip.basicPay).toBe(4530)
    expect(slip.grossPay).toBe(4530)
  })

  it('spreads the monthly contributions over the five weekly payrolls of October', () => {
    // statutory base = 755 × 313 / 12 = 19,692.92 -> SSS MSC 19,500: EE 975/mo
    expect(slip.sssEe).toBe(195)
    // PhilHealth 5% × 19,692.92 = 984.65 -> EE 492.32/mo; 3rd of 5 shares
    expect(slip.philhealthEe).toBe(98.46)
    // Pag-IBIG EE 200/mo
    expect(slip.pagibigEe).toBe(40)
  })

  it('withholds no tax from an MWE and pays exact centavos by default', () => {
    expect(slip.withholdingTax).toBe(0)
    expect(slip.taxableIncome).toBe(0)
    expect(slip.netPay).toBe(4196.54)
    expect(slip.roundingAdjustment).toBe(0)
  })

  it('tags earnings with BIR buckets', () => {
    expect(slip.earnings.find((l) => l.code === 'basic')).toMatchObject({ bir: 'basic', taxable: false })
  })

  it('rounds cash net pay up to the next whole peso', () => {
    const rounded = computePayslip({
      employee: mwe,
      settings: weeklySettings,
      period: week,
      tables: DEFAULT_TABLES,
      days: weekDays(WEEK_DAYS.map(shift)),
      runType: 'regular',
      rounding: { mode: 'round_up', carryIn: 0 },
    })
    expect(rounded.netPay).toBe(4197)
    expect(rounded.roundingAdjustment).toBe(0.46)
    expect(rounded.roundingCarryOut).toBe(0)
  })

  it('carries centavos forward instead of paying them now', () => {
    const carried = computePayslip({
      employee: mwe,
      settings: weeklySettings,
      period: week,
      tables: DEFAULT_TABLES,
      days: weekDays(WEEK_DAYS.map(shift)),
      runType: 'regular',
      rounding: { mode: 'carry_forward', carryIn: 0.7 },
    })
    // 4,196.54 + 0.70 carried in = 4,197.24 -> pay 4,197, carry 0.24
    expect(carried.netPay).toBe(4197)
    expect(carried.roundingCarryIn).toBe(0.7)
    expect(carried.roundingCarryOut).toBe(0.24)
    expect(carried.roundingAdjustment).toBe(0.46)
  })
})

describe('allocation of monthly amounts across pay periods', () => {
  it('weekly shares of a month sum exactly to the monthly amount', () => {
    const shares = [1, 2, 3, 4, 5].map((i) => allocateMonthly(492.32, i, 5))
    expect(shares.slice(0, 4)).toEqual([98.46, 98.46, 98.46, 98.46])
    expect(shares[4]).toBe(98.48)
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100)).toBe(49232)
  })

  it('honours first-period and last-period contribution timing', () => {
    const p = (index: number): PeriodInput => ({ start: '', end: '', index, count: 5 })
    expect(contributionShare(975, 'first_period', p(1))).toBe(975)
    expect(contributionShare(975, 'first_period', p(3))).toBe(0)
    expect(contributionShare(975, 'last_period', p(5))).toBe(975)
    expect(contributionShare(975, 'last_period', p(4))).toBe(0)
    expect(contributionShare(975, 'split', p(2))).toBe(195)
  })

  it('pays a monthly-rated weekly employee their monthly rate across the month', () => {
    const slip = computePayslip({
      employee: { ...mwe, isMinimumWageEarner: false, payType: 'monthly', monthlyRate: 26000, dailyRate: 0 },
      settings: weeklySettings,
      period: { ...week, index: 4, count: 4 },
      tables: DEFAULT_TABLES,
      days: weekDays(WEEK_DAYS.map(shift)),
      runType: 'regular',
    })
    expect(slip.earnings.find((l) => l.code === 'basic')?.amount).toBe(6500)
  })
})

describe('cash rounding', () => {
  it('leaves exact centavos when rounding is off', () => {
    expect(applyNetPayRounding(100.4, { mode: 'none', carryIn: 0 })).toEqual({
      paid: 100.4, adjustment: 0, carryIn: 0, carryOut: 0,
    })
  })

  it('rounds up, never down (no unauthorized deduction)', () => {
    expect(applyNetPayRounding(100.4, { mode: 'round_up', carryIn: 0 }).paid).toBe(101)
    expect(applyNetPayRounding(100, { mode: 'round_up', carryIn: 0 }).paid).toBe(100)
  })

  it('settles every carried centavo on the final payroll', () => {
    const r = applyNetPayRounding(100.4, { mode: 'carry_forward', carryIn: 0.7, settle: true })
    expect(r.paid).toBe(102)
    expect(r.carryOut).toBe(0)
    expect(r.adjustment).toBe(1.6)
  })

  it('does not round a negative net pay', () => {
    expect(applyNetPayRounding(-5.25, { mode: 'round_up', carryIn: 0 }).paid).toBe(-5.25)
  })
})

// ---- semi-monthly monthly-paid employee: allowances, union dues, adjustments ----

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 755,
}
const employee: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Juan Dela Cruz',
  payType: 'monthly',
  monthlyRate: 30000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const period: PeriodInput = { start: '2026-08-16', end: '2026-08-31', index: 2, count: 2 }
const WORKDAYS = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
  '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31',
]
const fullAttendance = computeAttendance({
  periodStart: period.start,
  periodEnd: period.end,
  schedule: employee.schedule,
  standardHoursPerDay: 8,
  gracePeriodMinutes: 0,
  entries: WORKDAYS.map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
  holidays: [],
  approvedLeaves: [],
})

describe('allowance bases and BIR categories', () => {
  const slip = computePayslip({
    employee: {
      ...employee,
      allowances: [
        { label: 'Rice subsidy', amount: 2000, category: 'de_minimis', basis: 'monthly', deMinimisKind: 'rice' },
        { label: 'Transportation', amount: 500, category: 'transportation', basis: 'per_period' },
        { label: 'COLA', amount: 50, category: 'cola', basis: 'per_day' },
      ],
    },
    settings,
    period,
    tables: DEFAULT_TABLES,
    days: fullAttendance,
    runType: 'regular',
  })

  it('allocates monthly allowances, repeats per-period ones, multiplies per-day ones', () => {
    const lines = slip.earnings.filter((l) => l.code === 'allowance')
    expect(lines.map((l) => l.amount)).toEqual([1000, 500, 550])
    expect(lines.map((l) => l.bir)).toEqual(['de_minimis', 'transportation', 'cola'])
    expect(lines.map((l) => l.taxable)).toEqual([false, true, true])
  })

  it('taxes only the taxable allowances', () => {
    // 15,000 + 500 + 550 − 1,225 contributions = 14,825
    expect(slip.taxableIncome).toBe(14825)
    expect(slip.withholdingTax).toBe(661.2)
  })

  it('exempts COLA for a minimum wage earner (part of the statutory minimum wage)', () => {
    const m = computePayslip({
      employee: {
        ...employee,
        isMinimumWageEarner: true,
        allowances: [{ label: 'COLA', amount: 50, category: 'cola', basis: 'per_day' }],
      },
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: fullAttendance,
      runType: 'regular',
    })
    expect(m.earnings.find((l) => l.code === 'allowance')?.taxable).toBe(false)
    expect(m.taxableIncome).toBe(0)
  })
})

describe('union dues and one-time adjustments', () => {
  const slip = computePayslip({
    employee: {
      ...employee,
      extraDeductions: [
        { id: 'd1', label: 'Union dues', category: 'union_dues', amount: 100 },
        { id: 'a2', label: 'Uniform', category: 'other', amount: 200, oneTime: true },
      ],
      oneTimeEarnings: [{ id: 'a1', label: 'Unpaid OT (Aug 3)', amount: 300, category: 'overtime' }],
    },
    settings,
    period,
    tables: DEFAULT_TABLES,
    days: fullAttendance,
    runType: 'regular',
  })

  it('excludes union dues from taxable compensation', () => {
    // 15,000 + 300 OT adjustment − 1,225 contributions − 100 union dues
    expect(slip.unionDues).toBe(100)
    expect(slip.taxableIncome).toBe(13975)
    expect(slip.withholdingTax).toBe(533.7)
  })

  it('labels one-time lines distinctly from recurring deductions', () => {
    expect(slip.earnings.find((l) => l.code === 'adjustment')).toMatchObject({ amount: 300, bir: 'overtime', meta: 'a1' })
    expect(slip.deductions.find((l) => l.code === 'other:union_dues')?.meta).toBe('d1')
    expect(slip.deductions.find((l) => l.code === 'adj:other')?.amount).toBe(200)
    expect(slip.otherDeductionsTotal).toBe(300)
  })
})

describe('13th month pay installments and the shared ₱90,000 cap', () => {
  const thirteenth = (extra: Partial<Parameters<typeof computePayslip>[0]>) =>
    computePayslip({
      employee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'thirteenth_month',
      ...extra,
    })

  it('pays only the balance after a mid-year installment', () => {
    expect(thirteenth({ ytdBasicPay: 120000 }).grossPay).toBe(10000)
    expect(thirteenth({ ytdBasicPay: 240000, ytdThirteenthPaid: 10000 }).grossPay).toBe(10000)
  })

  it('counts bonuses already paid against the cap', () => {
    const slip = thirteenth({ ytdBasicPay: 240000, ytdOtherBenefits: 85000 })
    expect(slip.grossPay).toBe(20000)
    expect(slip.taxableIncome).toBe(15000)
    expect(slip.earnings[0]).toMatchObject({ bir: 'thirteenth', taxable: false })
    expect(slip.basicPay).toBe(0) // never feeds a later 13th month
  })
})

describe('bonuses beyond the yearly ₱90,000 exemption are taxed when paid', () => {
  const withBonus = (amount: number, extra: Partial<Parameters<typeof computePayslip>[0]> = {}, emp = employee) =>
    computePayslip({
      employee: { ...emp, oneTimeEarnings: [{ id: 'b1', label: 'Mid-year bonus', amount, category: 'other_benefits' }] },
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: fullAttendance,
      runType: 'regular',
      ...extra,
    })

  it('keeps a bonus within what is left of the exemption out of taxable pay', () => {
    const slip = withBonus(50000, { benefitsExemptLeft: 90000 })
    expect(slip.taxableIncome).toBe(13775) // 15,000 basic − 1,225 contributions
  })

  it('taxes the part beyond what is left with this payroll', () => {
    const slip = withBonus(100000, { benefitsExemptLeft: 40000 })
    expect(slip.taxableIncome).toBe(73775) // 13,775 + the 60,000 excess
    expect(slip.withholdingTax).toBe(14381.2) // 4,270.70 + 25% of (73,775 − 33,333)
    expect(slip.trace.notes.some((n) => n.startsWith('₱60,000 of this payroll'))).toBe(true)
  })

  it('assumes the whole cap is left when the caller passes nothing', () => {
    expect(withBonus(100000).taxableIncome).toBe(23775)
  })

  it('taxes the excess for a minimum wage earner too', () => {
    const slip = withBonus(20000, { benefitsExemptLeft: 0 }, { ...employee, isMinimumWageEarner: true })
    expect(slip.taxableIncome).toBe(20000) // the minimum wage stays exempt
    expect(slip.withholdingTax).toBe(1604.1) // 937.50 + 20% of (20,000 − 16,667)
  })

  it('leaves the cap to the year when the payroll annualizes', () => {
    const slip = withBonus(100000, {
      benefitsExemptLeft: 0,
      annualization: { payMonth: '2026-12-01', ytd: [] },
    })
    expect(slip.trace.notes.some((n) => n.includes('of this payroll'))).toBe(false)
  })
})
