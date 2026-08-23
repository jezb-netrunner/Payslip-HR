import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import type {
  DayComputation,
  HolidayLite,
  PayrollEmployeeInput,
  PayrollSettingsInput,
  PeriodInput,
  TimeEntryLite,
} from './types'

// ---- fixtures ----

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 755,
}

const monthlyEmployee: PayrollEmployeeInput = {
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

// Aug 16–31, 2026: scheduled Mon–Fri days are 17-21, 24-28, 31 (11 days).
const WORKDAYS = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
  '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28',
  '2026-08-31',
]
const period: PeriodInput = { start: '2026-08-16', end: '2026-08-31', half: 'second' }

/** Manila 09:00 = 01:00Z; Manila 18:00 = 10:00Z. */
function entry(date: string, inUtc = '01:00', outUtc = '10:00', outDate = date): TimeEntryLite {
  return {
    work_date: date,
    clock_in: `${date}T${inUtc}:00Z`,
    clock_out: `${outDate}T${outUtc}:00Z`,
  }
}

function attendance(entries: TimeEntryLite[], holidays: HolidayLite[] = []): DayComputation[] {
  return computeAttendance({
    periodStart: period.start,
    periodEnd: period.end,
    schedule: monthlyEmployee.schedule,
    standardHoursPerDay: settings.standardHoursPerDay,
    gracePeriodMinutes: settings.gracePeriodMinutes,
    entries,
    holidays,
    approvedLeaves: [],
  })
}

describe('payslip: monthly-paid, semi-monthly, full attendance', () => {
  const days = attendance(WORKDAYS.map((d) => entry(d)))
  const slip = computePayslip({
    employee: monthlyEmployee,
    settings,
    period,
    tables: DEFAULT_TABLES,
    days,
    runType: 'regular',
  })

  it('pays half the monthly rate as basic', () => {
    expect(slip.basicPay).toBe(15000)
    expect(slip.grossPay).toBe(15000)
    expect(slip.daysWorked).toBe(11)
    expect(slip.absentDays).toBe(0)
  })

  it('splits monthly contributions across the two halves', () => {
    // SSS on MSC 30,000: EE 1,000 regular + 500 MPF monthly -> ×0.5
    expect(slip.sssEe).toBe(500)
    expect(slip.sssMpfEe).toBe(250)
    // PhilHealth 5% of 30,000 = 1,500; EE 750 -> ×0.5
    expect(slip.philhealthEe).toBe(375)
    // Pag-IBIG max 200 -> ×0.5
    expect(slip.pagibigEe).toBe(100)
    // employer shares
    expect(slip.sssEr).toBe(1000)
    expect(slip.sssMpfEr).toBe(500)
    expect(slip.sssEcEr).toBe(15) // EC 30 × 0.5
    expect(slip.philhealthEr).toBe(375)
    expect(slip.pagibigEr).toBe(100)
  })

  it('computes withholding tax on the semi-monthly table', () => {
    // taxable = 15,000 - 1,225 = 13,775 -> (13,775 - 10,417) × 15% = 503.70
    expect(slip.taxableIncome).toBe(13775)
    expect(slip.withholdingTax).toBe(503.7)
  })

  it('nets out correctly', () => {
    expect(slip.totalDeductions).toBe(1728.7)
    expect(slip.netPay).toBe(13271.3)
  })
})

describe('payslip: absences, tardiness and overtime', () => {
  it('deducts absences and lates at the derived daily/minute rate', () => {
    // absent on Aug 17; 30 minutes late on Aug 18 (Manila 09:30 = 01:30Z)
    const entries = WORKDAYS.filter((d) => d !== '2026-08-17').map((d) =>
      d === '2026-08-18' ? entry(d, '01:30') : entry(d),
    )
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    // daily = 30,000 × 12 / 261 = 1,379.31; per-minute = 2.8736
    const absence = slip.earnings.find((l) => l.code === 'absence')
    const late = slip.earnings.find((l) => l.code === 'late')
    expect(absence?.amount).toBe(-1379.31)
    expect(late?.amount).toBe(-86.21)
    expect(slip.absentDays).toBe(1)
    expect(slip.lateMinutes).toBe(30)
    expect(slip.withholdingTax).toBe(283.87)
    expect(slip.netPay).toBe(12025.61)
  })

  it('pays overtime at 125% on ordinary days', () => {
    // Aug 18 worked until Manila 20:00 (12:00Z): 10h net -> 2h OT
    const entries = WORKDAYS.map((d) => (d === '2026-08-18' ? entry(d, '01:00', '12:00') : entry(d)))
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    const ot = slip.earnings.find((l) => l.code === 'ot')
    // 2h × (1,379.31/8) × 1.25 = 431.03
    expect(ot?.amount).toBe(431.03)
    expect(slip.overtimeHours).toBe(2)
  })
})

describe('payslip: premium days', () => {
  it('adds +100% of hours worked on a regular holiday (monthly-paid)', () => {
    const holidays: HolidayLite[] = [
      { holiday_date: '2026-08-31', name: 'National Heroes Day', kind: 'regular' },
    ]
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(WORKDAYS.map((d) => entry(d)), holidays),
      runType: 'regular',
    })
    const hol = slip.earnings.find((l) => l.code === 'holiday')
    // 8h × 172.41 × (200% - 100% built-in) = 1,379.31
    expect(hol?.amount).toBe(1379.31)
  })

  it('does not deduct an unworked regular holiday for monthly-paid', () => {
    const holidays: HolidayLite[] = [
      { holiday_date: '2026-08-31', name: 'National Heroes Day', kind: 'regular' },
    ]
    const entries = WORKDAYS.filter((d) => d !== '2026-08-31').map((d) => entry(d))
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries, holidays),
      runType: 'regular',
    })
    expect(slip.earnings.find((l) => l.code === 'absence')).toBeUndefined()
    expect(slip.absentDays).toBe(0)
    expect(slip.grossPay).toBe(15000)
  })

  it('pays 130% for work on a rest day (monthly-paid gets the full 130% extra)', () => {
    const entries = [...WORKDAYS.map((d) => entry(d)), entry('2026-08-23')] // Sunday
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    const rest = slip.earnings.find((l) => l.code === 'restday')
    // 8h × 172.41 × 1.3 = 1,793.10
    expect(rest?.amount).toBe(1793.1)
  })

  it('pays night differential at 10% for 22:00–06:00 work', () => {
    // Single night shift: Manila Aug 17 22:00 (14:00Z) -> Aug 18 06:00 (22:00Z Aug 17)
    const entries: TimeEntryLite[] = [
      { work_date: '2026-08-17', clock_in: '2026-08-17T14:00:00Z', clock_out: '2026-08-17T22:00:00Z' },
    ]
    const days = attendance(entries)
    const d17 = days.find((d) => d.date === '2026-08-17')
    expect(d17?.workedMinutes).toBe(420) // 8h − 1h break
    expect(d17?.nightDiffMinutes).toBe(420)
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days,
      runType: 'regular',
    })
    const nd = slip.earnings.find((l) => l.code === 'nd')
    // 7h × 172.41 × 10% = 120.69
    expect(nd?.amount).toBe(120.69)
  })
})

describe('payslip: daily-paid and minimum wage earners', () => {
  const dailyEmployee: PayrollEmployeeInput = {
    ...monthlyEmployee,
    id: 'e2',
    payType: 'daily',
    monthlyRate: 0,
    dailyRate: 700,
  }

  it('pays only days worked (no work, no pay)', () => {
    const entries = WORKDAYS.slice(0, 5).map((d) => entry(d)) // 5 days
    const slip = computePayslip({
      employee: dailyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    expect(slip.basicPay).toBe(3500)
    // statutory base = 700 × 261 / 12 = 15,225 -> SSS MSC 15,000: EE 750/mo ×0.5
    expect(slip.sssEe).toBe(375)
    // PhilHealth 5% × 15,225 = 761.25 -> EE 380.62/mo ×0.5 = 190.31
    expect(slip.philhealthEe).toBe(190.31)
    // Pag-IBIG capped at 10,000 -> EE 200/mo ×0.5
    expect(slip.pagibigEe).toBe(100)
    expect(slip.withholdingTax).toBe(0) // below semi-monthly threshold
    expect(slip.netPay).toBe(2834.69)
  })

  it('exempts minimum wage earners from withholding tax even with OT', () => {
    const mwe: PayrollEmployeeInput = {
      ...monthlyEmployee,
      isMinimumWageEarner: true,
      monthlyRate: 40000, // high enough that tax would otherwise apply
    }
    const slip = computePayslip({
      employee: mwe,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(WORKDAYS.map((d) => entry(d, '01:00', '12:00'))),
      runType: 'regular',
    })
    expect(slip.withholdingTax).toBe(0)
    expect(slip.overtimeHours).toBeGreaterThan(0)
  })
})

describe('13th month pay (PD 851)', () => {
  it('pays 1/12 of YTD basic, tax-free under the ₱90,000 cap', () => {
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'thirteenth_month',
      ytdBasicPay: 240000,
    })
    expect(slip.grossPay).toBe(20000)
    expect(slip.withholdingTax).toBe(0)
    expect(slip.netPay).toBe(20000)
    expect(slip.sssEe).toBe(0) // no contributions on 13th month
  })

  it('taxes only the excess over the cap as supplemental compensation', () => {
    const highEarner: PayrollEmployeeInput = { ...monthlyEmployee, monthlyRate: 150000 }
    const slip = computePayslip({
      employee: highEarner,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'thirteenth_month',
      ytdBasicPay: 1800000,
    })
    expect(slip.grossPay).toBe(150000)
    expect(slip.taxableIncome).toBe(60000)
    // marginal: tax(145,550 + 60,000) - tax(145,550) on the monthly table
    expect(slip.withholdingTax).toBe(16944.15)
    expect(slip.netPay).toBe(133055.85)
  })
})
