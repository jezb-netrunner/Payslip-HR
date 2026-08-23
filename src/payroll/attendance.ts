// Turns raw time entries + holidays + approved leaves into per-day
// attendance facts (worked/OT/night-diff minutes, lates, absences) for a
// payroll period. All wall-clock math happens in Asia/Manila.

import {
  eachDate,
  hhmmToMinutes,
  isoWeekday,
  manilaInstant,
  manilaMinutesOfDay,
} from '../lib/manila'
import type {
  DayComputation,
  DayType,
  HolidayLite,
  LeaveLite,
  TimeEntryLite,
  WorkSchedule,
} from './types'

export interface AttendanceParams {
  periodStart: string
  periodEnd: string
  schedule: WorkSchedule
  standardHoursPerDay: number
  gracePeriodMinutes: number
  entries: TimeEntryLite[]
  holidays: HolidayLite[]
  approvedLeaves: LeaveLite[]
}

/** Overlap in minutes between [aStart, aEnd) and [bStart, bEnd) (epoch ms). */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart)
  const end = Math.min(aEnd, bEnd)
  return Math.max(0, (end - start) / 60000)
}

/** Night-diff minutes (Manila 22:00–06:00) for an interval. */
function nightDiffMinutesFor(dateStr: string, inMs: number, outMs: number): number {
  let total = 0
  // Windows that can overlap a shift anchored to work_date: the 22:00 window
  // of the previous day (ends 06:00 today), today's, and tomorrow morning's.
  for (const offset of [-1, 0]) {
    const d = new Date(Date.UTC(
      Number(dateStr.slice(0, 4)),
      Number(dateStr.slice(5, 7)) - 1,
      Number(dateStr.slice(8, 10)) + offset,
    ))
    const ds = d.toISOString().slice(0, 10)
    const windowStart = manilaInstant(ds, 22 * 60).getTime()
    const windowEnd = windowStart + 8 * 60 * 60 * 1000 // 22:00 -> 06:00 next day
    total += overlapMinutes(inMs, outMs, windowStart, windowEnd)
  }
  return total
}

function classifyDay(
  scheduled: boolean,
  holiday: HolidayLite | undefined,
): { dayType: DayType; holidayName?: string } {
  if (holiday?.kind === 'regular') {
    return {
      dayType: scheduled ? 'regular_holiday' : 'regular_holiday_rest',
      holidayName: holiday.name,
    }
  }
  if (holiday?.kind === 'special_non_working') {
    return {
      dayType: scheduled ? 'special_day' : 'special_day_rest',
      holidayName: holiday.name,
    }
  }
  // special_working days are ordinary working days (no premium)
  return {
    dayType: scheduled ? 'regular' : 'rest_day',
    holidayName: holiday?.name,
  }
}

export function computeAttendance(params: AttendanceParams): DayComputation[] {
  const {
    periodStart,
    periodEnd,
    schedule,
    standardHoursPerDay,
    gracePeriodMinutes,
    entries,
    holidays,
    approvedLeaves,
  } = params

  const standardMinutes = standardHoursPerDay * 60
  const schedStart = hhmmToMinutes(schedule.start)
  const schedEnd = hhmmToMinutes(schedule.end)

  const holidayByDate = new Map<string, HolidayLite>()
  for (const h of holidays) holidayByDate.set(h.holiday_date, h)

  const entriesByDate = new Map<string, TimeEntryLite[]>()
  for (const e of entries) {
    if (!e.clock_out) continue // open entries are not payable
    const list = entriesByDate.get(e.work_date) ?? []
    list.push(e)
    entriesByDate.set(e.work_date, list)
  }

  function leaveFor(date: string): LeaveLite | undefined {
    return approvedLeaves.find((l) => l.start_date <= date && date <= l.end_date)
  }

  const out: DayComputation[] = []
  for (const date of eachDate(periodStart, periodEnd)) {
    const weekday = isoWeekday(date)
    const scheduled = schedule.days.includes(weekday)
    const holiday = holidayByDate.get(date)
    const { dayType, holidayName } = classifyDay(scheduled, holiday)
    const dayEntries = (entriesByDate.get(date) ?? []).slice().sort((a, b) =>
      a.clock_in.localeCompare(b.clock_in),
    )

    let rawMinutes = 0
    let ndMinutes = 0
    let firstInMin: number | null = null
    let lastOutMin: number | null = null

    for (const e of dayEntries) {
      const inMs = new Date(e.clock_in).getTime()
      const outMs = new Date(e.clock_out as string).getTime()
      if (outMs <= inMs) continue
      rawMinutes += (outMs - inMs) / 60000
      ndMinutes += nightDiffMinutesFor(date, inMs, outMs)
      const inMin = manilaMinutesOfDay(new Date(e.clock_in))
      const outMin = manilaMinutesOfDay(new Date(e.clock_out as string))
      if (firstInMin === null || inMin < firstInMin) firstInMin = inMin
      // A clock-out past midnight reads as an early minute-of-day; treat it
      // as end-of-day for undertime purposes.
      const effectiveOut = outMin < inMin ? 24 * 60 : outMin
      if (lastOutMin === null || effectiveOut > lastOutMin) lastOutMin = effectiveOut
    }

    // Unpaid break is deducted only for shifts long enough to include it.
    const netMinutes =
      rawMinutes >= 6 * 60 ? Math.max(0, rawMinutes - schedule.break_minutes) : rawMinutes
    ndMinutes = Math.min(ndMinutes, netMinutes)

    const worked = netMinutes > 0
    const leave = leaveFor(date)

    let lateMinutes = 0
    let undertimeMinutes = 0
    if (worked && dayType === 'regular') {
      if (firstInMin !== null && firstInMin > schedStart + gracePeriodMinutes) {
        lateMinutes = Math.round(firstInMin - schedStart)
      }
      if (lastOutMin !== null && lastOutMin < schedEnd) {
        undertimeMinutes = Math.round(schedEnd - lastOutMin)
      }
      const cap = standardMinutes
      if (lateMinutes + undertimeMinutes > cap) {
        undertimeMinutes = Math.max(0, cap - lateMinutes)
      }
    }

    const payableMinutes = Math.min(netMinutes, standardMinutes)
    const otMinutes = Math.max(0, netMinutes - standardMinutes)

    const absent =
      scheduled && !worked && dayType === 'regular' && !leave

    out.push({
      date,
      dayType,
      scheduled,
      holidayName,
      workedMinutes: Math.round(netMinutes),
      payableMinutes: Math.round(payableMinutes),
      otMinutes: Math.round(otMinutes),
      nightDiffMinutes: Math.round(ndMinutes),
      lateMinutes,
      undertimeMinutes,
      absent,
      onPaidLeave: !worked && !!leave && leave.paid && scheduled && dayType === 'regular',
      onUnpaidLeave: !worked && !!leave && !leave.paid && scheduled && dayType === 'regular',
      leaveType: !worked && leave ? leave.type_name : undefined,
    })
  }
  return out
}
