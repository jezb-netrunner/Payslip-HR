import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip, periodShare } from './engine'
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
    // basic_pay stores EARNED basic (net of absences/lates) — the figure
    // PD 851 counts toward 13th month pay.
    expect(slip.basicPay).toBe(13534.48)
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

describe('review fixes: holidays on rest days, unpaid leave, divisor semantics', () => {
  const dailyEmployee: PayrollEmployeeInput = {
    ...monthlyEmployee,
    id: 'e3',
    payType: 'daily',
    monthlyRate: 0,
    dailyRate: 700,
  }
  const sundayHoliday: HolidayLite[] = [
    { holiday_date: '2026-08-23', name: 'Hypothetical Holiday', kind: 'regular' },
  ]

  it('pays a daily-paid employee 100% for an unworked regular holiday on a rest day', () => {
    const entries = WORKDAYS.slice(0, 5).map((d) => entry(d))
    const slip = computePayslip({
      employee: dailyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries, sundayHoliday),
      runType: 'regular',
    })
    const hol = slip.earnings.find((l) => l.code === 'holiday')
    expect(hol?.amount).toBe(700)
  })

  it('pays a monthly-paid employee (divisor 261) the daily rate for a holiday on a rest day', () => {
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(WORKDAYS.map((d) => entry(d)), sundayHoliday),
      runType: 'regular',
    })
    const hol = slip.earnings.find((l) => l.code === 'holiday')
    // 30,000 × 12 / 261 = 1,379.31 — the divisor does not deem rest days paid
    expect(hol?.amount).toBe(1379.31)
  })

  it('under divisor 365 pays only the +30% premium for rest-day work (base already in the rate)', () => {
    const s365 = { ...settings, workingDaysDivisor: 365 }
    const entries = [...WORKDAYS.map((d) => entry(d)), entry('2026-08-23')] // Sunday worked
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings: s365,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    const rest = slip.earnings.find((l) => l.code === 'restday')
    // daily = 30,000 × 12 / 365 = 986.30; extra = 0.3 × (986.30/8) × 8h = 295.89
    expect(rest?.amount).toBe(295.89)
  })

  it('withholds holiday pay from a daily-paid employee on leave without pay over the holiday', () => {
    const holidays: HolidayLite[] = [
      { holiday_date: '2026-08-31', name: 'National Heroes Day', kind: 'regular' },
    ]
    const entries = WORKDAYS.slice(0, 5).map((d) => entry(d)) // worked Aug 17-21 only
    const days = computeAttendance({
      periodStart: period.start,
      periodEnd: period.end,
      schedule: dailyEmployee.schedule,
      standardHoursPerDay: settings.standardHoursPerDay,
      gracePeriodMinutes: settings.gracePeriodMinutes,
      entries,
      holidays,
      approvedLeaves: [
        { start_date: '2026-08-24', end_date: '2026-09-04', paid: false, type_name: 'LWOP' },
      ],
    })
    const slip = computePayslip({
      employee: dailyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days,
      runType: 'regular',
    })
    expect(slip.earnings.find((l) => l.code === 'holiday')).toBeUndefined()
    expect(slip.earnings.find((l) => l.code === 'basic')?.amount).toBe(3500)
  })
})

describe('review fixes: ND on OT, split-half centavos', () => {
  it('stacks night differential on the OT rate for night hours beyond the standard day', () => {
    // Aug 18 worked Manila 09:00–24:00 (01:00Z–16:00Z): net 14h -> 6h OT,
    // 22:00–24:00 = 2 ND hours, all inside OT.
    const entries = WORKDAYS.map((d) => (d === '2026-08-18' ? entry(d, '01:00', '16:00') : entry(d)))
    const slip = computePayslip({
      employee: monthlyEmployee,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(entries),
      runType: 'regular',
    })
    const nd = slip.earnings.find((l) => l.code === 'nd')
    // 2h × (1,379.31/8) × 10% × 1.25 = 43.10
    expect(nd?.amount).toBe(43.1)
    const ot = slip.earnings.find((l) => l.code === 'ot')
    // 6h × 172.41 × 1.25 = 1,293.10
    expect(ot?.amount).toBe(1293.1)
  })

  it('periodShare: the two halves sum exactly to the monthly amount', () => {
    expect(periodShare(309.37, 0.5, 'first')).toBe(154.68)
    expect(periodShare(309.37, 0.5, 'second')).toBe(154.69)
    expect(periodShare(309.37, 1, 'full')).toBe(309.37)
    expect(periodShare(309.37, 0, 'first')).toBe(0)
  })

  it('deducts the odd-centavo monthly PhilHealth share without over-collecting across halves', () => {
    // 12,375 monthly basic -> PhilHealth EE 309.37/month; second half gets 154.69
    const emp: PayrollEmployeeInput = { ...monthlyEmployee, monthlyRate: 12375 }
    const slip = computePayslip({
      employee: emp,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: attendance(WORKDAYS.map((d) => entry(d))),
      runType: 'regular',
    })
    expect(slip.philhealthEe).toBe(154.69)
  })
})

describe('review fixes: attendance edge cases', () => {
  it('does not double-deduct the break when the employee clocked out for lunch', () => {
    // Two entries with a 60-min gap: 09:00–12:00 and 13:00–18:00 Manila
    const days = attendance([
      { work_date: '2026-08-18', clock_in: '2026-08-18T01:00:00Z', clock_out: '2026-08-18T04:00:00Z' },
      { work_date: '2026-08-18', clock_in: '2026-08-18T05:00:00Z', clock_out: '2026-08-18T10:00:00Z' },
    ])
    const d = days.find((x) => x.date === '2026-08-18')
    expect(d?.workedMinutes).toBe(480) // full 8h, break already off the clock
    expect(d?.otMinutes).toBe(0)
    expect(d?.undertimeMinutes).toBe(0)
  })

  it('detects undertime on schedules that cross midnight', () => {
    // Night schedule 22:00–06:00; left at 00:30 instead of 06:00
    const days = computeAttendance({
      periodStart: period.start,
      periodEnd: period.end,
      schedule: { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', break_minutes: 60 },
      standardHoursPerDay: 8,
      gracePeriodMinutes: 0,
      entries: [
        { work_date: '2026-08-17', clock_in: '2026-08-17T14:00:00Z', clock_out: '2026-08-17T16:30:00Z' },
      ],
      holidays: [],
      approvedLeaves: [],
    })
    const d = days.find((x) => x.date === '2026-08-17')
    expect(d?.workedMinutes).toBe(150)
    expect(d?.undertimeMinutes).toBe(330) // short of 06:00 by 5.5h
  })

  it('waives undertime when total hours meet the standard day (early clock-in)', () => {
    // Manila 05:00–17:00 on Aug 18: 11h net -> 3h OT, left 1h before schedule
    // end but the standard day is complete.
    const days = attendance([
      { work_date: '2026-08-18', clock_in: '2026-08-17T21:00:00Z', clock_out: '2026-08-18T09:00:00Z' },
    ])
    const d = days.find((x) => x.date === '2026-08-18')
    expect(d?.otMinutes).toBe(180)
    expect(d?.undertimeMinutes).toBe(0)
    expect(d?.nightDiffMinutes).toBe(60) // 05:00–06:00 is within the ND window
  })

  it('caps tardiness deductions at the unworked portion of the day', () => {
    // Clocks in 17:30, works 30 min: deduction is 7.5h, never more than a day
    const days = attendance([
      { work_date: '2026-08-18', clock_in: '2026-08-18T09:30:00Z', clock_out: '2026-08-18T10:00:00Z' },
    ])
    const d = days.find((x) => x.date === '2026-08-18')
    expect(d?.workedMinutes).toBe(30)
    expect((d?.lateMinutes ?? 0) + (d?.undertimeMinutes ?? 0)).toBe(450)
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
