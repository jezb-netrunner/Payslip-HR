import { describe, expect, it } from 'vitest'
import { manilaWallToIso } from './manila'
import {
  buildTimeReport,
  clock12,
  detailCsv,
  pairTimes,
  scheduleText,
  sumTotals,
  summaryCsv,
  type ReportEmployee,
  type ReportEntry,
  type TimeReportParams,
} from './timeReport'

const dayShift = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 }

function emp(id: string, over: Partial<ReportEmployee> = {}): ReportEmployee {
  return {
    id,
    employee_no: id.toUpperCase(),
    first_name: 'Ana',
    middle_name: null,
    last_name: id,
    suffix: null,
    position: 'Staff',
    department: '',
    hire_date: '2026-01-05',
    separation_date: null,
    pay_frequency: 'semi_monthly',
    work_schedule: dayShift,
    ...over,
  }
}

function entry(employeeId: string, date: string, tin: string, tout: string | null, opts: { outNext?: boolean; corrected?: boolean } = {}): ReportEntry {
  return {
    employee_id: employeeId,
    work_date: date,
    clock_in: manilaWallToIso(date, tin),
    clock_out: tout === null ? null : manilaWallToIso(date, tout, opts.outNext),
    flags: opts.corrected ? ['corrected'] : [],
  }
}

const base: Omit<TimeReportParams, 'employees' | 'entries'> = {
  from: '2026-10-01',
  to: '2026-10-13',
  today: '2026-10-12',
  leaves: [{ employee_id: 'a', start_date: '2026-10-06', end_date: '2026-10-06', name: 'Vacation Leave', paid: true }],
  holidays: [{ holiday_date: '2026-10-09', name: 'Company Day', kind: 'special_non_working' }],
  standardHoursPerDay: 8,
  gracePeriodMinutes: 0,
}

// Oct 1 Thu … Oct 13 Tue, 2026
const entries: ReportEntry[] = [
  entry('a', '2026-10-01', '08:00', '17:00'),
  entry('a', '2026-10-02', '08:20', '17:00'), // late, short day
  entry('a', '2026-10-03', '09:00', '13:00'), // Saturday: rest day worked
  // Oct 5 Mon: nothing — absent; Oct 6: paid leave
  entry('a', '2026-10-07', '08:00', null), // no time out
  entry('a', '2026-10-08', '08:00', '20:00'), // 3h overtime
  entry('a', '2026-10-09', '08:00', '17:00', { corrected: true }), // worked a special day
  entry('a', '2026-10-12', '08:00', '12:00'), // split shift
  entry('a', '2026-10-12', '13:00', '17:00'),
  // Oct 13 Tue: after today — not an absence
]

describe('time in/out report', () => {
  const [r] = buildTimeReport({ ...base, employees: [emp('a')], entries })
  const day = (d: string) => r.days.find((x) => x.date === d)!

  it('uses payroll day figures: lateness, overtime, rest-day work, holidays', () => {
    expect(day('2026-10-01')).toMatchObject({ workedMinutes: 480, regularMinutes: 480, lateMinutes: 0, remarks: [] })
    expect(day('2026-10-02')).toMatchObject({ workedMinutes: 460, lateMinutes: 20, undertimeMinutes: 0 })
    expect(day('2026-10-03')).toMatchObject({ workedMinutes: 240, scheduled: false, remarks: ['Rest day'] })
    expect(day('2026-10-08')).toMatchObject({ workedMinutes: 660, regularMinutes: 480, otMinutes: 180 })
    expect(day('2026-10-09').remarks).toEqual(['Special non-working day: Company Day', 'Corrected on request'])
    expect(day('2026-10-12').pairs).toHaveLength(2)
    // the gap between the pairs is the break: nothing else comes off
    expect(day('2026-10-12').workedMinutes).toBe(480)
  })

  it('flags absences, leave and entries without a time out — never days after today', () => {
    expect(day('2026-10-05')).toMatchObject({ absent: true, remarks: ['Absent'] })
    expect(day('2026-10-06')).toMatchObject({ absent: false, leave: { name: 'Vacation Leave', paid: true } })
    expect(day('2026-10-07')).toMatchObject({ absent: true, missingTimeOut: true, workedMinutes: 0 })
    expect(day('2026-10-07').remarks).toEqual(['Absent: time in without a time out'])
    expect(day('2026-10-07').pairs[0]).toMatchObject({ timeIn: '08:00', timeOut: null })
    expect(day('2026-10-13')).toMatchObject({ upcoming: true, absent: false, remarks: [] })
  })

  it('totals the range like payroll counts it', () => {
    expect(r.totals).toMatchObject({
      workdays: 7, // Oct 1, 2, 5, 6, 7, 8, 12: not the special day, not Oct 13 (after today)
      daysWorked: 6,
      absences: 2,
      paidLeaveDays: 1,
      unpaidLeaveDays: 0,
      workedMinutes: 480 + 460 + 240 + 660 + 480 + 480,
      otMinutes: 180,
      lateDays: 1,
      lateMinutes: 20,
      restDaysWorked: 1,
      holidaysWorked: 1,
      missingTimeOut: 1,
    })
  })

  it('clips the range to the employment and skips people not employed in it', () => {
    const reports = buildTimeReport({
      ...base,
      employees: [
        emp('a', { separation_date: '2026-10-06' }),
        emp('b', { hire_date: '2026-10-08' }),
        emp('c', { hire_date: '2026-11-01' }),
      ],
      entries,
    })
    expect(reports.map((x) => [x.employee.id, x.from, x.to])).toEqual([
      ['a', '2026-10-01', '2026-10-06'],
      ['b', '2026-10-08', '2026-10-13'],
    ])
    // b has no time in/out at all: every past workday is an absence, the holiday is not
    expect(reports[1].totals).toMatchObject({ workdays: 2, absences: 2, daysWorked: 0 }) // Oct 8 and 12
  })

  it('marks the next-day half of an overnight shift', () => {
    const night = emp('n', { work_schedule: { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', break_minutes: 0 } })
    const [n] = buildTimeReport({
      ...base,
      leaves: [],
      employees: [night],
      entries: [entry('n', '2026-10-05', '22:00', '06:00', { outNext: true })],
    })
    const d = n.days.find((x) => x.date === '2026-10-05')!
    expect(d).toMatchObject({ workedMinutes: 480, nightDiffMinutes: 480, lateMinutes: 0, undertimeMinutes: 0 })
    expect(pairTimes(d.pairs[0])).toEqual({ timeIn: '10:00 PM', timeOut: '6:00 AM (+1)' })
  })

  it('exports a summary and a day-by-day CSV', () => {
    const reports = buildTimeReport({ ...base, employees: [emp('a'), emp('b', { hire_date: '2026-10-12' })], entries })
    const summary = summaryCsv(reports)
    expect(summary[0].slice(0, 3)).toEqual(['Employee No', 'Employee', 'Position'])
    expect(summary).toHaveLength(4) // header, 2 employees, total
    const total = summary[3]
    expect(total[1]).toBe('TOTAL')
    expect(total[7]).toBe(sumTotals(reports).daysWorked)
    expect(total[11]).toBe(46.67) // 2,800 minutes

    const detail = detailCsv(reports)
    // the split shift widens every row to two pairs
    expect(detail[0].slice(5, 9)).toEqual(['Time in', 'Time out', 'Time in 2', 'Time out 2'])
    const split = detail.find((row) => row[0] === 'A' && row[2] === '2026-10-12')!
    expect(split.slice(3, 9)).toEqual(['Mon', '08:00-17:00', '08:00', '12:00', '13:00', '17:00'])
    const open = detail.find((row) => row[0] === 'A' && row[2] === '2026-10-07')!
    expect(open.slice(5, 7)).toEqual(['08:00', ''])
    expect(open[open.length - 1]).toBe('Absent: time in without a time out')
    expect(detail.filter((row) => row[0] === 'B')).toHaveLength(2) // Oct 12–13
  })
})

describe('report formatting', () => {
  it('prints 12-hour clock times', () => {
    expect(clock12('00:05')).toBe('12:05 AM')
    expect(clock12('12:00')).toBe('12:00 PM')
    expect(clock12('13:05')).toBe('1:05 PM')
  })

  it('describes the schedule in words', () => {
    expect(scheduleText(dayShift)).toBe('Mon–Fri 8:00 AM–5:00 PM, 60 min break')
    expect(scheduleText({ ...dayShift, days: [1, 3, 5] })).toBe('Mon, Wed, Fri 8:00 AM–5:00 PM, 60 min break')
    expect(scheduleText({ ...dayShift, days: [6, 7, 1, 2, 4, 5] }).split(' 8:')[0]).toBe('Mon, Tue, Thu–Sun')
  })
})
