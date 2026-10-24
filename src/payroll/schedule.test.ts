import { describe, expect, it } from 'vitest'
import { manilaWallToIso } from '../lib/manila'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { makeResolver, patternFromWorkSchedule, sameShift, shiftWorkMinutes } from './schedule'
import type { PayrollEmployeeInput, PayrollSettingsInput, ScheduleSource, Shift, TimeEntryLite, WeekPattern } from './types'

const day: Shift = { start: '08:00', end: '17:00', break_minutes: 60 }
const halfDay: Shift = { start: '08:00', end: '12:00', break_minutes: 0, name: 'Half day' }
const night: Shift = { start: '22:00', end: '06:00', break_minutes: 60 }
const base = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 }
// Mon–Fri 8–5, Saturday half day
const sixDay: WeekPattern = [day, day, day, day, day, halfDay, null]

function e(date: string, tin: string, tout: string, outNext = false): TimeEntryLite {
  return { work_date: date, clock_in: manilaWallToIso(date, tin), clock_out: manilaWallToIso(date, tout, outNext) }
}

function attend(schedule: ScheduleSource, entries: TimeEntryLite[], from = '2026-11-02', to = '2026-11-08', grace = 0) {
  return computeAttendance({
    periodStart: from,
    periodEnd: to,
    schedule,
    standardHoursPerDay: 8,
    gracePeriodMinutes: grace,
    entries,
    holidays: [],
    approvedLeaves: [],
  })
}

describe('schedule resolution', () => {
  // Nov 2, 2026 is a Monday
  const resolve = makeResolver(
    base,
    [
      { effective_from: '2026-11-09', pattern: [night, night, night, night, night, null, null] },
      { effective_from: '2026-11-02', pattern: sixDay },
    ],
    [
      { work_date: '2026-11-04', shift: null }, // rest day moved to Wednesday
      { work_date: '2026-11-08', shift: { start: '10:00', end: '19:00', break_minutes: 30 } }, // works a Sunday
    ],
  )

  it('uses the base schedule before the first pattern, then the pattern in force', () => {
    expect(resolve('2026-10-30').shift).toMatchObject({ start: '09:00', end: '18:00' })
    expect(resolve('2026-10-31').shift).toBeNull() // Saturday under the base
    expect(resolve('2026-11-07').shift).toEqual(halfDay)
    expect(resolve('2026-11-09').shift).toEqual(night)
    expect(resolve('2026-11-14').shift).toBeNull()
  })

  it('lets a roster change for a date win', () => {
    expect(resolve('2026-11-04').shift).toBeNull()
    expect(resolve('2026-11-08').shift).toMatchObject({ start: '10:00', break_minutes: 30 })
    expect(resolve('2026-11-05').shift).toEqual(day)
  })

  it('keeps a break for rest-day work and compares shifts by their times', () => {
    expect(resolve('2026-11-04').restDayBreakMinutes).toBe(60)
    expect(makeResolver(base, [{ effective_from: '2026-01-01', pattern: [null, null, null, null, null, null, null] }])('2026-11-02').restDayBreakMinutes).toBe(60)
    expect(sameShift({ ...day, name: 'x' }, day)).toBe(true)
    expect(sameShift(day, { ...day, flex_minutes: 30 })).toBe(false)
    expect(sameShift(null, null)).toBe(true)
    expect(shiftWorkMinutes(night)).toBe(420)
    expect(patternFromWorkSchedule(base)[5]).toBeNull()
  })
})

describe('attendance against each date\'s shift', () => {
  const pattern = makeResolver(base, [{ effective_from: '2026-01-01', pattern: sixDay }])

  it('expects a half day its own hours', () => {
    const [sat] = attend(pattern, [e('2026-11-07', '08:00', '12:00')], '2026-11-07', '2026-11-07')
    expect(sat).toMatchObject({ scheduled: true, dayType: 'regular', expectedMinutes: 240, workedMinutes: 240, undertimeMinutes: 0, otMinutes: 0 })
    const [short] = attend(pattern, [e('2026-11-07', '08:00', '11:00')], '2026-11-07', '2026-11-07')
    expect(short.undertimeMinutes).toBe(60)
    // two hours past a half day is still regular time (overtime starts after 8)
    const [longer] = attend(pattern, [e('2026-11-07', '08:00', '14:00')], '2026-11-07', '2026-11-07')
    expect(longer).toMatchObject({ workedMinutes: 360, payableMinutes: 360, otMinutes: 0 })
    const [absent] = attend(pattern, [], '2026-11-07', '2026-11-07')
    expect(absent).toMatchObject({ absent: true, expectedMinutes: 240 })
  })

  it('follows a moved rest day and a swapped shift', () => {
    const roster = makeResolver(base, [{ effective_from: '2026-01-01', pattern: sixDay }], [
      { work_date: '2026-11-04', shift: null },
      { work_date: '2026-11-05', shift: night },
    ])
    const days = attend(roster, [e('2026-11-04', '08:00', '17:00'), e('2026-11-05', '22:30', '06:00', true)])
    expect(days.find((d) => d.date === '2026-11-04')).toMatchObject({ scheduled: false, dayType: 'rest_day', workedMinutes: 480 })
    // late against the night shift, not the day shift
    expect(days.find((d) => d.date === '2026-11-05')).toMatchObject({ lateMinutes: 30, workedMinutes: 390, expectedMinutes: 420 })
  })

  it('counts a flexible start as on time and moves the end with it', () => {
    const flexi = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [{ ...day, flex_minutes: 60 }, day, day, day, day, null, null] }])
    // in 8:50 (inside the window), out 17:30: 20 minutes short — left early, not late
    const [mon] = attend(flexi, [e('2026-11-02', '08:50', '17:30')], '2026-11-02', '2026-11-02')
    expect(mon).toMatchObject({ lateMinutes: 0, undertimeMinutes: 20 })
    // in 9:20, past the window: late from 9:00
    const [late] = attend(flexi, [e('2026-11-02', '09:20', '18:00')], '2026-11-02', '2026-11-02')
    expect(late).toMatchObject({ lateMinutes: 20, undertimeMinutes: 0 })
    // the same day on a fixed 8:00 start: the shortfall is tardiness
    const [fixed] = attend(makeResolver(base, [{ effective_from: '2026-01-01', pattern: sixDay }]), [e('2026-11-02', '08:50', '17:30')], '2026-11-02', '2026-11-02')
    expect(fixed).toMatchObject({ lateMinutes: 20, undertimeMinutes: 0 })
  })

  it('treats a compressed-workweek shift as regular time to its end', () => {
    const cww: Shift = { start: '07:00', end: '18:00', break_minutes: 60, compressed: true }
    const four = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [cww, cww, cww, cww, null, null, null] }])
    const [full] = attend(four, [e('2026-11-02', '07:00', '18:00')], '2026-11-02', '2026-11-02')
    expect(full).toMatchObject({ workedMinutes: 600, payableMinutes: 600, otMinutes: 0, expectedMinutes: 600, undertimeMinutes: 0 })
    const [past] = attend(four, [e('2026-11-02', '07:00', '19:00')], '2026-11-02', '2026-11-02')
    expect(past.otMinutes).toBe(60)
    // without the flag, hours past 8 are overtime
    const plain = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [{ ...cww, compressed: false }, null, null, null, null, null, null] }])
    const [ot] = attend(plain, [e('2026-11-02', '07:00', '18:00')], '2026-11-02', '2026-11-02')
    expect(ot).toMatchObject({ payableMinutes: 480, otMinutes: 120, expectedMinutes: 480 })
  })

  it('deducts the pattern\'s break on rest-day work', () => {
    const longBreak = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [{ ...day, break_minutes: 90 }, day, day, day, day, null, null] }])
    const [sun] = attend(longBreak, [e('2026-11-08', '08:00', '17:00')], '2026-11-08', '2026-11-08')
    expect(sun).toMatchObject({ scheduled: false, workedMinutes: 450 })
  })

  it('counts a meal break under an hour as paid time (IRR Book III Rule I Sec. 7)', () => {
    const shortBreak = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [{ start: '08:00', end: '16:30', break_minutes: 30 }, day, day, day, day, null, null] }])
    const [mon] = attend(shortBreak, [e('2026-11-02', '08:00', '16:30')], '2026-11-02', '2026-11-02')
    // 8.5 paid hours: half an hour of overtime, and nothing short
    expect(mon).toMatchObject({ workedMinutes: 510, expectedMinutes: 480, otMinutes: 30, undertimeMinutes: 0 })
    expect(shiftWorkMinutes({ start: '08:00', end: '16:30', break_minutes: 30 })).toBe(510)
  })
})

describe('pay against each date\'s shift', () => {
  const settings: PayrollSettingsInput = {
    standardHoursPerDay: 8,
    workingDaysDivisor: 313,
    gracePeriodMinutes: 0,
    nightDiffRate: 0.1,
    contributionTiming: 'split',
    payFrequency: 'weekly',
    minimumWageDaily: 0,
  }
  const employee = (over: Partial<PayrollEmployeeInput>): PayrollEmployeeInput => ({
    id: 'e1',
    name: 'Ana',
    payType: 'monthly',
    monthlyRate: 26080,
    dailyRate: 0,
    isMinimumWageEarner: false,
    schedule: base,
    allowances: [],
    extraDeductions: [],
    ...over,
  })
  const week = { start: '2026-11-02', end: '2026-11-08', index: 1, count: 4 }
  const pay = (emp: PayrollEmployeeInput, schedule: ScheduleSource, entries: TimeEntryLite[], leaves: { start_date: string; end_date: string; paid: boolean; type_name: string }[] = []) =>
    computePayslip({
      employee: emp,
      settings,
      period: week,
      tables: DEFAULT_TABLES,
      days: computeAttendance({
        periodStart: week.start,
        periodEnd: week.end,
        schedule,
        standardHoursPerDay: 8,
        gracePeriodMinutes: 0,
        entries,
        holidays: [],
        approvedLeaves: leaves,
      }),
      runType: 'regular',
    })
  const pattern = makeResolver(base, [{ effective_from: '2026-01-01', pattern: sixDay }])
  const weekdays = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']

  it('docks half a day for a missed half-day Saturday (monthly-paid)', () => {
    // daily = 26,080 × 12 / 313 = 999.87
    const slip = pay(employee({}), pattern, weekdays.map((d) => e(d, '08:00', '17:00')))
    const absence = slip.earnings.find((l) => l.code === 'absence')
    expect(absence?.amount).toBe(-499.94)
    expect(absence?.label).toBe("Absences (1 day/s, 0.5 days' pay)")
    expect(slip.absentDays).toBe(1)
  })

  it('pays a monthly-paid employee the hours past a half day at the regular rate', () => {
    const slip = pay(employee({}), pattern, [...weekdays.map((d) => e(d, '08:00', '17:00')), e('2026-11-07', '08:00', '14:00')])
    const extra = slip.earnings.find((l) => l.code === 'extra_hours')
    // hourly = 999.87 / 8; 2 hours past the half day, not overtime
    expect(extra).toMatchObject({ amount: 249.97, hours: 2, bir: 'basic' })
    expect(slip.overtimeHours).toBe(0)
    expect(slip.earnings.find((l) => l.code === 'absence')).toBeUndefined()
  })

  it('pays a daily-paid half day and its paid leave as half a day', () => {
    const daily = employee({ payType: 'daily', monthlyRate: 0, dailyRate: 800 })
    const worked = pay(daily, pattern, [...weekdays.map((d) => e(d, '08:00', '17:00')), e('2026-11-07', '08:00', '12:00')])
    expect(worked.basicPay).toBe(4400) // 5 × 800 + 0.5 × 800
    const onLeave = pay(daily, pattern, weekdays.map((d) => e(d, '08:00', '17:00')), [
      { start_date: '2026-11-07', end_date: '2026-11-07', paid: true, type_name: 'Vacation Leave' },
    ])
    expect(onLeave.basicPay).toBe(4400)
  })

  it('pays a daily-paid compressed workweek day as its hours', () => {
    const cww: Shift = { start: '07:00', end: '18:00', break_minutes: 60, compressed: true }
    const four = makeResolver(base, [{ effective_from: '2026-01-01', pattern: [cww, cww, cww, cww, null, null, null] }])
    const daily = employee({ payType: 'daily', monthlyRate: 0, dailyRate: 800 })
    const slip = pay(daily, four, weekdays.slice(0, 4).map((d) => e(d, '07:00', '18:00')))
    // 4 days × 10 regular hours = 40 hours = 5 standard days, no overtime
    expect(slip.basicPay).toBe(4000)
    expect(slip.overtimeHours).toBe(0)
  })
})

describe('short shifts with an unpaid break', () => {
  it('takes the break once the shift is worked, so the shift pays its own hours', () => {
    const half = { start: '08:00', end: '13:00', break_minutes: 60 }
    const resolver = makeResolver({ days: [], start: '08:00', end: '17:00', break_minutes: 60 }, [], [{ work_date: '2026-10-17', shift: half }])
    const day = (tout: string) =>
      computeAttendance({
        periodStart: '2026-10-17',
        periodEnd: '2026-10-17',
        schedule: resolver,
        standardHoursPerDay: 8,
        gracePeriodMinutes: 0,
        entries: [{ work_date: '2026-10-17', clock_in: manilaWallToIso('2026-10-17', '08:00'), clock_out: manilaWallToIso('2026-10-17', tout) }],
        holidays: [],
        approvedLeaves: [],
      })[0]
    expect(day('13:00')).toMatchObject({ expectedMinutes: 240, workedMinutes: 240, payableMinutes: 240, undertimeMinutes: 0, otMinutes: 0 })
    // left at noon: four hours worked, no lunch taken — the shift's four hours of work
    expect(day('12:00')).toMatchObject({ workedMinutes: 240, undertimeMinutes: 0 })
  })
})
