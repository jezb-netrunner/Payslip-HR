// Leave day counting shared by the employee portal views.

import type { Holiday, LeaveRequest } from './db'
import { eachDate, isoWeekday } from './manila'

type HolidayLite = Pick<Holiday, 'holiday_date' | 'kind'>

/** Scheduled workdays in [start, end], not counting non-working holidays (already paid days off). */
export function leaveWorkdays(start: string, end: string, scheduleDays: number[], holidays: HolidayLite[] = []): number {
  if (end < start) return 0
  const off = new Set(holidays.filter((h) => h.kind !== 'special_working').map((h) => h.holiday_date))
  return eachDate(start, end).filter((d) => scheduleDays.includes(isoWeekday(d)) && !off.has(d)).length
}

/** Days of a leave charged to a calendar year: a leave can straddle New Year. */
export function leaveDaysInYear(
  r: Pick<LeaveRequest, 'start_date' | 'end_date' | 'days'>,
  year: number,
  scheduleDays: number[],
  holidays: HolidayLite[] = [],
): number {
  const y0 = `${year}-01-01`
  const y1 = `${year}-12-31`
  if (r.end_date < y0 || r.start_date > y1) return 0
  if (r.start_date >= y0 && r.end_date <= y1) return Number(r.days)
  return leaveWorkdays(r.start_date > y0 ? r.start_date : y0, r.end_date < y1 ? r.end_date : y1, scheduleDays, holidays)
}
