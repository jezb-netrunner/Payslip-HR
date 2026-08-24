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
  // of the previous day (ends 06:00 today), and today's (ends 06:00 tomorrow).
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
  const schedEndRaw = hhmmToMinutes(schedule.end)
  // Normalize overnight schedules (e.g. 22:00–06:00) onto a continuous axis.
  const overnight = schedEndRaw <= schedStart
  const schedEnd = overnight ? schedEndRaw + 1440 : schedEndRaw

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
    let gapMinutes = 0 // off-the-clock gaps between same-day entries
    let prevOutMs: number | null = null
    let firstInMin: number | null = null
    let lastOutMin: number | null = null
    const intervals: { inMs: number; outMs: number }[] = []

    for (const e of dayEntries) {
      const inMs = new Date(e.clock_in).getTime()
      const outMs = new Date(e.clock_out as string).getTime()
      if (outMs <= inMs) continue
      intervals.push({ inMs, outMs })
      if (prevOutMs !== null && inMs > prevOutMs) gapMinutes += (inMs - prevOutMs) / 60000
      prevOutMs = Math.max(prevOutMs ?? outMs, outMs)
      rawMinutes += (outMs - inMs) / 60000
      ndMinutes += nightDiffMinutesFor(date, inMs, outMs)

      // Minutes-of-day on the schedule's continuous axis: for overnight
      // schedules a punch after midnight belongs to the tail of the shift.
      let inMin = manilaMinutesOfDay(new Date(e.clock_in))
      if (overnight && inMin < schedStart - 720) inMin += 1440
      let outMin = manilaMinutesOfDay(new Date(e.clock_out as string))
      if (outMin <= inMin) outMin += 1440 // clock-out past midnight
      if (firstInMin === null || inMin < firstInMin) firstInMin = inMin
      if (lastOutMin === null || outMin > lastOutMin) lastOutMin = outMin
    }

    // Deduct the unpaid break only to the extent it wasn't already taken
    // off the clock (multiple entries with gaps = employee clocked out for
    // the break themselves).
    const effectiveBreak = Math.max(0, schedule.break_minutes - gapMinutes)
    const netMinutes =
      rawMinutes >= 6 * 60 ? Math.max(0, rawMinutes - effectiveBreak) : rawMinutes
    ndMinutes = Math.min(ndMinutes, netMinutes)

    const worked = netMinutes > 0
    const leave = leaveFor(date)

    const payableMinutes = Math.min(netMinutes, standardMinutes)
    const otMinutes = Math.max(0, netMinutes - standardMinutes)

    // Night-diff minutes that fall inside the OVERTIME portion of the day
    // (the chronological tail of worked time) — the engine prices these at
    // 10% of the OT rate instead of the plain day rate. Break placement
    // inside a continuous span is unknown, so this is a close approximation.
    let ndOtMinutes = 0
    if (otMinutes > 0 && ndMinutes > 0) {
      let otRemaining = otMinutes
      for (let i = intervals.length - 1; i >= 0 && otRemaining > 0; i--) {
        const span = (intervals[i].outMs - intervals[i].inMs) / 60000
        const take = Math.min(span, otRemaining)
        const tailStartMs = intervals[i].outMs - take * 60000
        ndOtMinutes += nightDiffMinutesFor(date, tailStartMs, intervals[i].outMs)
        otRemaining -= take
      }
      ndOtMinutes = Math.min(ndOtMinutes, ndMinutes)
    }

    let lateMinutes = 0
    let undertimeMinutes = 0
    if (worked && dayType === 'regular') {
      if (firstInMin !== null && firstInMin > schedStart + gracePeriodMinutes) {
        lateMinutes = Math.round(firstInMin - schedStart)
      }
      if (lastOutMin !== null && lastOutMin < schedEnd) {
        undertimeMinutes = Math.round(schedEnd - lastOutMin)
      }
      // Deduct exactly the true hours shortfall: an employee who completed
      // the standard day (even shifted, or with early clock-in covering a
      // late departure) owes nothing; a short day is docked exactly the
      // unworked portion — including interior off-the-clock gaps beyond the
      // scheduled break, which edge-based late/undertime cannot see.
      const maxDeduct = Math.max(0, Math.round(standardMinutes - payableMinutes))
      lateMinutes = Math.min(lateMinutes, maxDeduct)
      undertimeMinutes = Math.min(undertimeMinutes, Math.max(0, maxDeduct - lateMinutes))
      const interiorShortfall = maxDeduct - lateMinutes - undertimeMinutes
      if (interiorShortfall > 0) undertimeMinutes += interiorShortfall
    }

    const absent = scheduled && !worked && dayType === 'regular' && !leave

    out.push({
      date,
      dayType,
      scheduled,
      holidayName,
      workedMinutes: Math.round(netMinutes),
      payableMinutes: Math.round(payableMinutes),
      otMinutes: Math.round(otMinutes),
      nightDiffMinutes: Math.round(ndMinutes),
      ndOtMinutes: Math.round(ndOtMinutes),
      lateMinutes,
      undertimeMinutes,
      absent,
      // Leave flags are set for every unworked day the leave covers; the
      // engine decides per day type what they mean (deduction on regular
      // days, holiday-pay qualification on holidays).
      onPaidLeave: !worked && !!leave && leave.paid,
      onUnpaidLeave: !worked && !!leave && !leave.paid,
      leaveType: !worked && leave ? leave.type_name : undefined,
    })
  }
  return out
}
