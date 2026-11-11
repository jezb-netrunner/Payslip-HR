// Half-day leave: one request covers hours not worked up to half the shift.
// A paid half is inside a monthly rate and is paid at the day's rate to a
// daily-paid employee; an unpaid half is leave without pay; lateness and
// undertime are what is left after it.

import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import type { HolidayLite, LeaveLite, PayrollEmployeeInput, PayrollSettingsInput, PeriodInput, TimeEntryLite } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 755,
}
// 09:00-18:00 with an hour's meal break: eight hours
const schedule = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 }
const monthly: PayrollEmployeeInput = {
  id: 'e1', name: 'Ana Reyes', payType: 'monthly', monthlyRate: 30000, dailyRate: 0, isMinimumWageEarner: false,
  schedule, allowances: [], extraDeductions: [],
}
const daily: PayrollEmployeeInput = { ...monthly, id: 'e2', payType: 'daily', monthlyRate: 0, dailyRate: 800 }
const period: PeriodInput = { start: '2026-08-16', end: '2026-08-31', index: 2, count: 2 }
const DAY = '2026-08-19' // a Wednesday

/** Manila wall time on DAY (UTC+8). */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${DAY}T${String(h - 8).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
}
const entry = (timeIn: string, timeOut: string): TimeEntryLite => ({ work_date: DAY, clock_in: at(timeIn), clock_out: at(timeOut) })
const leave = (half: 'am' | 'pm', paid = true, name = 'Vacation Leave'): LeaveLite => ({ start_date: DAY, end_date: DAY, paid, type_name: name, type_code: paid ? 'VL' : 'LWOP', half_day: half })

function day(entries: TimeEntryLite[], leaves: LeaveLite[], holidays: HolidayLite[] = [], sched = schedule) {
  return computeAttendance({ periodStart: DAY, periodEnd: DAY, schedule: sched, standardHoursPerDay: 8, gracePeriodMinutes: 0, entries, holidays, approvedLeaves: leaves })[0]
}
function slip(employee: PayrollEmployeeInput, entries: TimeEntryLite[], leaves: LeaveLite[]) {
  return computePayslip({ employee, settings, period, tables: DEFAULT_TABLES, days: [day(entries, leaves)], runType: 'regular' })
}
const line = (s: ReturnType<typeof slip>, code: string) => s.earnings.filter((l) => l.code === code).reduce((t, l) => t + l.amount, 0)

describe('half-day leave: attendance', () => {
  it('an afternoon leave covers the half not worked: no undertime', () => {
    const d = day([entry('09:00', '13:00')], [leave('pm')])
    expect(d.payableMinutes).toBe(240)
    expect(d.halfLeave).toEqual({ paidMinutes: 240, unpaidMinutes: 0, typeName: 'Vacation Leave' })
    expect(d.lateMinutes).toBe(0)
    expect(d.undertimeMinutes).toBe(0)
    expect(d.absent).toBe(false)
    expect(d.onPaidLeave).toBe(false)
  })

  it('a morning leave covers the late arrival: no lateness, and only the hours not worked', () => {
    // 13:00 to 18:00 is five hours on the clock (no meal break): the leave covers the other three
    const d = day([entry('13:00', '18:00')], [leave('am')])
    expect(d.payableMinutes).toBe(300)
    expect(d.halfLeave?.paidMinutes).toBe(180)
    expect(d.lateMinutes).toBe(0)
    expect(d.undertimeMinutes).toBe(0)
  })

  it('what the leave does not cover is still undertime or lateness, on the right side', () => {
    // morning leave, in at 13:00, out at 16:00: an hour short at the end
    const early = day([entry('13:00', '16:00')], [leave('am')])
    expect(early.halfLeave?.paidMinutes).toBe(240)
    expect(early.lateMinutes).toBe(0)
    expect(early.undertimeMinutes).toBe(60)
    // afternoon leave, in at 09:30, out at 13:00: half an hour late
    const late = day([entry('09:30', '13:00')], [leave('pm')])
    expect(late.halfLeave?.paidMinutes).toBe(240)
    expect(late.lateMinutes).toBe(30)
    expect(late.undertimeMinutes).toBe(0)
  })

  it('with no time in/out at all, the other half is half a day of absence', () => {
    const d = day([], [leave('pm')])
    expect(d.halfLeave?.paidMinutes).toBe(240)
    expect(d.partialAbsenceMinutes).toBe(240)
    expect(d.absent).toBe(false)
  })

  it('two halves make the day: a paid morning and an unpaid afternoon', () => {
    const d = day([], [leave('am'), leave('pm', false, 'Leave Without Pay')])
    expect(d.halfLeave).toEqual({ paidMinutes: 240, unpaidMinutes: 240, typeName: 'Vacation Leave + Leave Without Pay' })
    expect(d.partialAbsenceMinutes).toBeUndefined()
    expect(d.absent).toBe(false)
  })

  it('covers nothing when the whole shift was worked, and does not apply on a rest day or a holiday', () => {
    expect(day([entry('09:00', '18:00')], [leave('pm')]).halfLeave).toEqual({ paidMinutes: 0, unpaidMinutes: 0, typeName: 'Vacation Leave' })
    expect(day([], [leave('pm')], [{ holiday_date: DAY, name: 'Holiday', kind: 'regular' }]).halfLeave).toBeUndefined()
    const weekend = { ...schedule, days: [1, 2] }
    expect(day([], [leave('pm')], [], weekend).halfLeave).toBeUndefined()
  })

  it('a whole-day leave on the date wins over a half', () => {
    const d = day([], [leave('pm'), { start_date: DAY, end_date: DAY, paid: true, type_name: 'Sick Leave' }])
    expect(d.onPaidLeave).toBe(true)
    expect(d.halfLeave).toBeUndefined()
  })
})

describe('half-day leave: pay', () => {
  it('monthly rate, paid half: the salary is whole, nothing docked', () => {
    const s = slip(monthly, [entry('09:00', '13:00')], [leave('pm')])
    expect(s.grossPay).toBe(15000)
    expect(s.earnings.some((l) => ['undertime', 'late', 'absence'].includes(l.code))).toBe(false)
    expect(s.absentDays).toBe(0)
  })

  it('monthly rate, unpaid half: half a day of leave without pay, not undertime', () => {
    const s = slip(monthly, [entry('09:00', '13:00')], [leave('pm', false, 'Leave Without Pay')])
    // 30,000 x 12 / 261 = 1,379.31 a day
    expect(line(s, 'absence')).toBe(-689.66)
    expect(line(s, 'undertime')).toBe(0)
    expect(s.undertimeMinutes).toBe(0)
    expect(s.absentDays).toBe(0.5)
  })

  it('monthly rate, paid half and no time for the other half: half a day of absence, and a warning', () => {
    const s = slip(monthly, [], [leave('pm')])
    expect(line(s, 'absence')).toBe(-689.66)
    expect(s.absentDays).toBe(0.5)
    expect(s.trace.warnings.some((w) => w.startsWith('Half-day leave on Aug 19 with no time in/out for the other half'))).toBe(true)
  })

  it('daily rate, paid half: the half worked plus the half on leave is a day', () => {
    const s = slip(daily, [entry('09:00', '13:00')], [leave('pm')])
    expect(s.basicPay).toBe(800)
    // the half on leave is inside the day worked, not a day more
    expect(s.earnings.find((l) => l.code === 'basic')?.label).toBe('Basic Pay (1 day/s worked, 0.5 of them on paid leave)')
    // an unpaid half pays the half worked only
    expect(slip(daily, [entry('09:00', '13:00')], [leave('pm', false)]).basicPay).toBe(400)
    // the half on leave alone, with no time for the other half
    const alone = slip(daily, [], [leave('pm')])
    expect(alone.basicPay).toBe(400)
    expect(alone.earnings.find((l) => l.code === 'basic')?.label).toBe('Basic Pay (0 day/s worked + 0.5 paid leave)')
    expect(alone.absentDays).toBe(0.5)
  })

  it('daily rate: a half day within a day worked and a whole day on leave read apart', () => {
    // Aug 19: the morning worked, the afternoon on leave. Aug 20: the whole day on leave
    const days = computeAttendance({
      periodStart: DAY, periodEnd: '2026-08-20', schedule, standardHoursPerDay: 8, gracePeriodMinutes: 0,
      entries: [entry('09:00', '13:00')], holidays: [],
      approvedLeaves: [leave('pm'), { start_date: '2026-08-20', end_date: '2026-08-20', paid: true, type_name: 'Vacation Leave', type_code: 'VL' }],
    })
    const s = computePayslip({ employee: daily, settings, period, tables: DEFAULT_TABLES, days, runType: 'regular' })
    expect(s.basicPay).toBe(1600)
    expect(s.earnings.find((l) => l.code === 'basic')?.label).toBe('Basic Pay (1 day/s worked, 0.5 of them on paid leave + 1 paid leave)')
  })

  it('an allowance per day counts the day once, or the half paid without work', () => {
    const perDay = { ...daily, allowances: [{ label: 'Meal', amount: 100, category: 'other_taxable' as const, basis: 'per_day' as const }] }
    expect(line(slip(perDay, [entry('09:00', '13:00')], [leave('pm')]), 'allowance')).toBe(100)
    expect(line(slip(perDay, [], [leave('pm')]), 'allowance')).toBe(50)
  })

  it('says so when the leave changed nothing: the whole shift is on record', () => {
    const s = slip(monthly, [entry('09:00', '18:00')], [leave('pm')])
    expect(s.grossPay).toBe(15000)
    expect(s.trace.warnings.some((w) => w.includes('the leave changed nothing in pay'))).toBe(true)
  })

  it('a fixed salary: an unpaid half is deducted, a paid half is not', () => {
    const fixed = { ...monthly, fixedSalary: true }
    expect(slip(fixed, [], [leave('pm')]).grossPay).toBe(15000)
    const unpaid = slip(fixed, [], [leave('pm', false, 'Leave Without Pay')])
    expect(line(unpaid, 'absence')).toBe(-689.66)
    expect(unpaid.trace.warnings.some((w) => w.startsWith('Half-day leave'))).toBe(false)
  })
})
