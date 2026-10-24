// Leave day counting shared by the employee portal views.

import { toResolver } from '../payroll/schedule'
import type { ScheduleSource } from '../payroll/types'
import type { Holiday, LeaveRequest, LeaveType } from './db'
import { fmtDate } from './format'
import { addMonths, eachDate, isoWeekday } from './manila'

type HolidayLite = Pick<Holiday, 'holiday_date' | 'kind'>

/**
 * Statutory leaves granted per qualifying event or status (childbirth,
 * surgery, solo-parent ID, VAWC certification), not a yearly balance everyone
 * holds. Maternity leave also runs in calendar days, so a workday balance
 * would mislead.
 */
const EVENT_LEAVE_CODES = ['ML', 'PL', 'MCW', 'SPL', 'VAWC']

/** Whether a leave type shows as a balance: event leaves only once HR sets the employee's entitlement. */
export function showsBalance(t: Pick<LeaveType, 'code' | 'default_annual_days'>, entitlement: number | undefined): boolean {
  if (entitlement !== undefined) return entitlement > 0
  return !EVENT_LEAVE_CODES.includes(t.code) && Number(t.default_annual_days) > 0
}

/**
 * First date an employee may use a leave type: the hire date plus the type's
 * months of service (SIL: 12, Labor Code Art. 95), or null when it needs
 * none. The database's guard_leave_request applies the same rule.
 */
export function eligibleFrom(t: Pick<LeaveType, 'min_service_months'>, hireDate: string): string | null {
  const months = Number(t.min_service_months ?? 0)
  return months > 0 ? addMonths(hireDate, months) : null
}

/**
 * Whether a leave of this type may start on `date`: the service requirement
 * is met, or HR set credits above zero for that year (granting it sooner).
 */
export function usableOn(
  t: Pick<LeaveType, 'min_service_months'>,
  hireDate: string,
  date: string,
  creditsThatYear: number | undefined,
): boolean {
  const from = eligibleFrom(t, hireDate)
  return !from || date >= from || (creditsThatYear ?? 0) > 0
}

/** "Service Incentive Leave can be used from Oct 23, 2027, after 12 months of service." */
export function notYetUsable(t: Pick<LeaveType, 'name' | 'min_service_months'>, from: string): string {
  return `${t.name} can be used from ${fmtDate(from)}, after ${t.min_service_months} months of service.`
}

/** Weekdays worked (1 = Mon … 7 = Sun), or the schedule in force on each date. */
export type Workdays = number[] | ScheduleSource

function workdayTest(schedule: Workdays): (date: string) => boolean {
  if (Array.isArray(schedule)) return (d) => schedule.includes(isoWeekday(d))
  const resolve = toResolver(schedule)
  return (d) => resolve(d).shift !== null
}

/** Leaves that run in calendar days, rest days and holidays included: maternity leave (RA 11210, 105 days). */
const CALENDAR_DAY_LEAVE_CODES = ['ML']

export function countsCalendarDays(t: Pick<LeaveType, 'code'> | undefined): boolean {
  return !!t && CALENDAR_DAY_LEAVE_CODES.includes(t.code)
}

/** Days a leave of this type takes in [start, end]: calendar days, or the scheduled workdays. */
export function leaveDays(
  t: Pick<LeaveType, 'code'> | undefined,
  start: string,
  end: string,
  schedule: Workdays,
  holidays: HolidayLite[] = [],
): number {
  if (end < start) return 0
  return countsCalendarDays(t) ? eachDate(start, end).length : leaveWorkdays(start, end, schedule, holidays)
}

/** Scheduled workdays in [start, end], not counting non-working holidays (already paid days off). */
export function leaveWorkdays(start: string, end: string, schedule: Workdays, holidays: HolidayLite[] = []): number {
  if (end < start) return 0
  const off = new Set(holidays.filter((h) => h.kind !== 'special_working').map((h) => h.holiday_date))
  const works = workdayTest(schedule)
  return eachDate(start, end).filter((d) => works(d) && !off.has(d)).length
}

/** Days of a leave charged to a calendar year: a leave can straddle New Year. */
export function leaveDaysInYear(
  r: Pick<LeaveRequest, 'start_date' | 'end_date' | 'days'>,
  year: number,
  schedule: Workdays,
  holidays: HolidayLite[] = [],
  type?: Pick<LeaveType, 'code'>,
): number {
  const y0 = `${year}-01-01`
  const y1 = `${year}-12-31`
  if (r.end_date < y0 || r.start_date > y1) return 0
  if (r.start_date >= y0 && r.end_date <= y1) return Number(r.days)
  return leaveDays(type, r.start_date > y0 ? r.start_date : y0, r.end_date < y1 ? r.end_date : y1, schedule, holidays)
}
