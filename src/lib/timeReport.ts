// Time In/Out report: each employee's daily time record (DTR) over a date
// range, plus totals. Days come from payroll's own computeAttendance, so the
// hours, overtime, lateness and absences shown are the ones payroll pays or
// docks. Times are Manila wall time. Every string here is plain text the
// built-in PDF fonts can print (no peso sign, no narrow no-break spaces).

import { computeAttendance } from '../payroll/attendance'
import { sameShift } from '../payroll/schedule'
import { round2, type DayType, type HolidayLite, type ScheduleResolver, type Shift, type WeekPattern } from '../payroll/types'
import type { CsvValue } from './csv'
import type { Employee, TimeEntry } from './db'
import { clock12, fullName, plural } from './format'
import { isoWeekday, manilaDateStr, manilaHHMM } from './manila'
import { patternSummary } from './shiftText'

export { clock12 }

export type ReportEmployee = Pick<
  Employee,
  | 'id'
  | 'employee_no'
  | 'first_name'
  | 'middle_name'
  | 'last_name'
  | 'suffix'
  | 'position'
  | 'department'
  | 'hire_date'
  | 'separation_date'
  | 'pay_frequency'
  | 'work_schedule'
>

export type ReportEntry = Pick<TimeEntry, 'employee_id' | 'work_date' | 'clock_in' | 'clock_out' | 'flags'>

/** An approved leave. */
export interface ReportLeave {
  employee_id: string
  start_date: string
  end_date: string
  name: string
  paid: boolean
}

/** One time in/out pair, as "HH:MM" Manila wall time. */
export interface ReportPair {
  timeIn: string
  timeOut: string | null
  /** falls on the day after the work date (overnight shift) */
  inNextDay: boolean
  outNextDay: boolean
}

export interface ReportDay {
  date: string
  dayType: DayType
  scheduled: boolean
  /** the shift scheduled that date (null = rest day) */
  shift: Shift | null
  holiday?: HolidayLite
  pairs: ReportPair[]
  /** net of the unpaid break; overtime included */
  workedMinutes: number
  /** worked minutes within the standard day */
  regularMinutes: number
  otMinutes: number
  nightDiffMinutes: number
  lateMinutes: number
  undertimeMinutes: number
  absent: boolean
  /** approved leave charged on this workday */
  leave?: { name: string; paid: boolean }
  /** an entry without a time out: payroll doesn't count it */
  missingTimeOut: boolean
  /** an entry set by an approved correction request */
  corrected: boolean
  /** after the report's "today": not yet worked, so never an absence */
  upcoming: boolean
  remarks: string[]
}

export interface ReportTotals {
  /** scheduled working days (not holidays or rest days) up to today */
  workdays: number
  daysWorked: number
  absences: number
  paidLeaveDays: number
  unpaidLeaveDays: number
  workedMinutes: number
  regularMinutes: number
  otMinutes: number
  nightDiffMinutes: number
  lateDays: number
  lateMinutes: number
  undertimeDays: number
  undertimeMinutes: number
  restDaysWorked: number
  holidaysWorked: number
  missingTimeOut: number
}

export interface EmployeeTimeReport {
  employee: ReportEmployee
  /** the requested range clipped to the employment */
  from: string
  to: string
  /** the schedule over the range, e.g. "Mon–Fri 8:00 AM–5:00 PM · Sat 8:00 AM–12:00 PM (2 days differ)" */
  schedule: string
  days: ReportDay[]
  totals: ReportTotals
}

export interface TimeReportParams {
  from: string
  to: string
  /** days after this date are upcoming, not absences */
  today: string
  employees: ReportEmployee[]
  entries: ReportEntry[]
  leaves: ReportLeave[]
  holidays: HolidayLite[]
  /** each employee's schedule per date (patterns and roster changes); the base schedule when missing */
  schedules?: Map<string, ScheduleResolver>
  standardHoursPerDay: number
  gracePeriodMinutes: number
}

export const HOLIDAY_KIND_LABELS: Record<HolidayLite['kind'], string> = {
  regular: 'Regular holiday',
  special_non_working: 'Special non-working day',
  special_working: 'Special working day',
}

const HOLIDAY_TYPES = new Set<DayType>(['regular_holiday', 'regular_holiday_rest', 'special_day', 'special_day_rest'])

export function emptyTotals(): ReportTotals {
  return {
    workdays: 0,
    daysWorked: 0,
    absences: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    workedMinutes: 0,
    regularMinutes: 0,
    otMinutes: 0,
    nightDiffMinutes: 0,
    lateDays: 0,
    lateMinutes: 0,
    undertimeDays: 0,
    undertimeMinutes: 0,
    restDaysWorked: 0,
    holidaysWorked: 0,
    missingTimeOut: 0,
  }
}

function groupBy<T extends { employee_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) m.set(r.employee_id, [...(m.get(r.employee_id) ?? []), r])
  return m
}

export function buildTimeReport(p: TimeReportParams): EmployeeTimeReport[] {
  const holidayByDate = new Map(p.holidays.map((h) => [h.holiday_date, h]))
  const entriesBy = groupBy(p.entries)
  const leavesBy = groupBy(p.leaves)
  const out: EmployeeTimeReport[] = []
  for (const employee of p.employees) {
    // days before the hire or after the separation are not this job's days
    const from = employee.hire_date > p.from ? employee.hire_date : p.from
    const to = employee.separation_date && employee.separation_date < p.to ? employee.separation_date : p.to
    if (from > to) continue
    const entries = (entriesBy.get(employee.id) ?? []).filter((e) => e.work_date >= from && e.work_date <= to)
    const byDate = new Map<string, ReportEntry[]>()
    for (const e of entries) byDate.set(e.work_date, [...(byDate.get(e.work_date) ?? []), e])
    const computed = computeAttendance({
      periodStart: from,
      periodEnd: to,
      schedule: p.schedules?.get(employee.id) ?? employee.work_schedule,
      standardHoursPerDay: p.standardHoursPerDay,
      gracePeriodMinutes: p.gracePeriodMinutes,
      entries,
      holidays: p.holidays,
      approvedLeaves: (leavesBy.get(employee.id) ?? []).map((l) => ({
        start_date: l.start_date,
        end_date: l.end_date,
        paid: l.paid,
        type_name: l.name,
      })),
    })

    const days = computed.map((d): ReportDay => {
      const list = (byDate.get(d.date) ?? []).slice().sort((a, b) => a.clock_in.localeCompare(b.clock_in))
      const pairs = list.map((e) => ({
        timeIn: manilaHHMM(e.clock_in),
        timeOut: e.clock_out ? manilaHHMM(e.clock_out) : null,
        inNextDay: manilaDateStr(new Date(e.clock_in)) > d.date,
        outNextDay: !!e.clock_out && manilaDateStr(new Date(e.clock_out)) > d.date,
      }))
      const upcoming = d.date > p.today
      const missingTimeOut = list.some((e) => !e.clock_out)
      // review_time_correction flags the entries it changes or creates
      const corrected = list.some((e) => e.flags?.includes('corrected'))
      const absent = d.absent && !upcoming
      // leave is charged on workdays only (as payroll and the leave balances count it)
      const leave =
        (d.onPaidLeave || d.onUnpaidLeave) && d.dayType === 'regular'
          ? { name: d.leaveType ?? 'Leave', paid: d.onPaidLeave }
          : undefined
      const holiday = holidayByDate.get(d.date)
      const remarks: string[] = []
      if (holiday) remarks.push(`${HOLIDAY_KIND_LABELS[holiday.kind]}: ${holiday.name}`)
      if (!d.scheduled) remarks.push('Rest day')
      if (leave) remarks.push(leave.paid ? leave.name : `${leave.name} (unpaid)`)
      if (absent) remarks.push(missingTimeOut ? 'Absent: time in without a time out' : 'Absent')
      else if (missingTimeOut) remarks.push('Entry without a time out (not counted)')
      if (corrected) remarks.push('Corrected on request')
      return {
        date: d.date,
        dayType: d.dayType,
        scheduled: d.scheduled,
        shift: d.shift ?? null,
        holiday,
        pairs,
        workedMinutes: d.workedMinutes,
        regularMinutes: d.payableMinutes,
        otMinutes: d.otMinutes,
        nightDiffMinutes: d.nightDiffMinutes,
        lateMinutes: d.lateMinutes,
        undertimeMinutes: d.undertimeMinutes,
        absent,
        leave,
        missingTimeOut,
        corrected,
        upcoming,
        remarks,
      }
    })

    const totals = emptyTotals()
    for (const d of days) {
      const worked = d.workedMinutes > 0
      if (d.dayType === 'regular' && !d.upcoming) totals.workdays += 1
      if (worked) totals.daysWorked += 1
      if (d.absent) totals.absences += 1
      if (d.leave?.paid) totals.paidLeaveDays += 1
      if (d.leave && !d.leave.paid) totals.unpaidLeaveDays += 1
      totals.workedMinutes += d.workedMinutes
      totals.regularMinutes += d.regularMinutes
      totals.otMinutes += d.otMinutes
      totals.nightDiffMinutes += d.nightDiffMinutes
      if (d.lateMinutes > 0) totals.lateDays += 1
      totals.lateMinutes += d.lateMinutes
      if (d.undertimeMinutes > 0) totals.undertimeDays += 1
      totals.undertimeMinutes += d.undertimeMinutes
      if (worked && !d.scheduled) totals.restDaysWorked += 1
      if (worked && HOLIDAY_TYPES.has(d.dayType)) totals.holidaysWorked += 1
      if (d.missingTimeOut) totals.missingTimeOut += 1
    }
    out.push({ employee, from, to, schedule: scheduleOfDays(days), days, totals })
  }
  return out
}

/**
 * The schedule a range of days follows: each weekday's most usual shift, and
 * how many days had another (a roster change, or a new schedule mid-range).
 */
export function scheduleOfDays(days: Pick<ReportDay, 'date' | 'shift'>[]): string {
  const pattern: WeekPattern = Array.from({ length: 7 }, (_, wd) => {
    const counts: { shift: Shift | null; n: number }[] = []
    for (const d of days) {
      if (isoWeekday(d.date) - 1 !== wd) continue
      const c = counts.find((x) => sameShift(x.shift, d.shift))
      if (c) c.n += 1
      else counts.push({ shift: d.shift, n: 1 })
    }
    return counts.sort((a, b) => b.n - a.n)[0]?.shift ?? null
  })
  const differ = days.filter((d) => !sameShift(d.shift, pattern[isoWeekday(d.date) - 1])).length
  return patternSummary(pattern) + (differ ? ` (${plural(differ, 'day')} differ)` : '')
}

/** Totals of several employees. */
export function sumTotals(reports: EmployeeTimeReport[]): ReportTotals {
  const t = emptyTotals()
  for (const r of reports) {
    for (const k of Object.keys(t) as (keyof ReportTotals)[]) t[k] += r.totals[k]
  }
  return t
}

// ---------- display helpers ----------

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayName(date: string): string {
  return DAY_NAMES[isoWeekday(date) - 1]
}

/** 2026-10-06 -> "Oct 6" (or "Oct 6, 2026"), independent of the browser's locale. */
export function shortDate(date: string, withYear = false): string {
  const s = `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`
  return withYear ? `${s}, ${date.slice(0, 4)}` : s
}

/** A pair's time in and time out for display; "(+1)" marks the next day. */
export function pairTimes(p: ReportPair, fmt: (hhmm: string) => string = clock12): { timeIn: string; timeOut: string } {
  return {
    timeIn: fmt(p.timeIn) + (p.inNextDay ? ' (+1)' : ''),
    timeOut: p.timeOut === null ? 'no time out' : fmt(p.timeOut) + (p.outNextDay ? ' (+1)' : ''),
  }
}

/** Minutes as decimal hours, e.g. 510 -> 8.5 */
export function hoursOf(minutes: number): number {
  return round2(minutes / 60)
}

// ---------- CSV ----------

export function summaryCsv(reports: EmployeeTimeReport[]): CsvValue[][] {
  const header = [
    'Employee No', 'Employee', 'Position', 'Department', 'From', 'To', 'Workdays', 'Days worked', 'Absences',
    'Paid leave days', 'Unpaid leave days', 'Hours worked', 'Regular hours', 'Overtime hours', 'Night diff hours',
    'Times late', 'Late (min)', 'Times undertime', 'Undertime (min)', 'Rest days worked', 'Holidays worked',
    'Days without time out',
  ]
  const figures = (t: ReportTotals) => [
    t.workdays, t.daysWorked, t.absences, t.paidLeaveDays, t.unpaidLeaveDays, hoursOf(t.workedMinutes),
    hoursOf(t.regularMinutes), hoursOf(t.otMinutes), hoursOf(t.nightDiffMinutes), t.lateDays, t.lateMinutes,
    t.undertimeDays, t.undertimeMinutes, t.restDaysWorked, t.holidaysWorked, t.missingTimeOut,
  ]
  return [
    header,
    ...reports.map((r) => [
      r.employee.employee_no, fullName(r.employee), r.employee.position, r.employee.department, r.from, r.to,
      ...figures(r.totals),
    ]),
    ['', 'TOTAL', '', '', '', '', ...figures(sumTotals(reports))],
  ]
}

export function detailCsv(reports: EmployeeTimeReport[]): CsvValue[][] {
  // one row per day; a split shift adds "Time in 2 / Time out 2" columns
  const maxPairs = Math.max(1, ...reports.flatMap((r) => r.days.map((d) => d.pairs.length)))
  const pairHeads = Array.from({ length: maxPairs }, (_, i) =>
    i === 0 ? ['Time in', 'Time out'] : [`Time in ${i + 1}`, `Time out ${i + 1}`],
  ).flat()
  const header = [
    'Employee No', 'Employee', 'Date', 'Day', 'Schedule', ...pairHeads, 'Hours worked', 'Regular hours',
    'Overtime hours', 'Night diff hours', 'Late (min)', 'Undertime (min)', 'Remarks',
  ]
  const rows: CsvValue[][] = [header]
  for (const r of reports) {
    for (const d of r.days) {
      const times = Array.from({ length: maxPairs }, (_, i) => {
        const pair = d.pairs[i]
        if (!pair) return ['', '']
        const t = pairTimes(pair, (hhmm) => hhmm)
        return [t.timeIn, pair.timeOut === null ? '' : t.timeOut]
      }).flat()
      rows.push([
        r.employee.employee_no, fullName(r.employee), d.date, dayName(d.date),
        d.shift ? `${d.shift.start}-${d.shift.end}` : 'Rest day', ...times, hoursOf(d.workedMinutes), hoursOf(d.regularMinutes),
        hoursOf(d.otMinutes), hoursOf(d.nightDiffMinutes), d.lateMinutes, d.undertimeMinutes, d.remarks.join('; '),
      ])
    }
  }
  return rows
}
