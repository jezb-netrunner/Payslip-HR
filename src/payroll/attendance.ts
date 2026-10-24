// Turns raw time entries + holidays + approved leaves into per-day
// attendance facts (worked/OT/night-diff minutes, lates, absences) for a
// payroll period. All wall-clock math happens in Asia/Manila. Each date is
// measured against the shift scheduled that date (src/payroll/schedule.ts):
// a half day expects its own hours, a flexible start moves the shift with
// the time in, and a compressed-workweek shift is regular time to its end.

import {
  eachDate,
  hhmmToMinutes,
  manilaInstant,
  manilaMinutesOfDay,
} from '../lib/manila'
import { shiftSpan, shiftWorkMinutes, toResolver, unpaidBreak } from './schedule'
import type {
  DayComputation,
  DayType,
  HolidayLite,
  LeaveLite,
  ScheduleSource,
  TimeEntryLite,
} from './types'

export interface AttendanceParams {
  periodStart: string
  periodEnd: string
  /** a fixed weekly schedule, or the schedule in force on each date */
  schedule: ScheduleSource
  standardHoursPerDay: number
  gracePeriodMinutes: number
  entries: TimeEntryLite[]
  holidays: HolidayLite[]
  approvedLeaves: LeaveLite[]
}

/** Rest periods ("coffee breaks") of 5 to 20 minutes are hours worked (IRR Book III, Rule I, Sec. 7). */
export const REST_PERIOD_MINUTES = 20

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
  const scheduleOn = toResolver(schedule)

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
    const { shift, restDayBreakMinutes } = scheduleOn(date)
    const scheduled = shift !== null
    const holiday = holidayByDate.get(date)
    const { dayType, holidayName } = classifyDay(scheduled, holiday)
    const dayEntries = (entriesByDate.get(date) ?? []).slice().sort((a, b) =>
      a.clock_in.localeCompare(b.clock_in),
    )
    // The day's shift on a continuous axis: an overnight one (22:00–06:00)
    // ends past 1440.
    const schedStart = shift ? hhmmToMinutes(shift.start) : 0
    const schedEnd = shift ? schedStart + shiftSpan(shift) : 0
    const overnight = !!shift && hhmmToMinutes(shift.end) <= schedStart
    const flex = shift?.flex_minutes ?? 0
    // only a meal break of an hour or more is unpaid (a shorter one is paid time)
    const scheduledBreak = shift ? shift.break_minutes : restDayBreakMinutes
    const breakMinutes = unpaidBreak(scheduledBreak)
    // Regular time is the standard day, or a longer compressed-workweek
    // shift; the shift expects its own hours up to that (a half day, 4).
    const shiftMinutes = shift ? shiftWorkMinutes(shift) : 0
    const regularCap = shift?.compressed ? Math.max(standardMinutes, shiftMinutes) : standardMinutes
    const expectedMinutes = shift ? Math.min(shiftMinutes, regularCap) : 0

    let rawMinutes = 0
    let ndMinutes = 0
    const gaps: number[] = [] // off-the-clock gaps between same-day entries, in minutes
    let prevOutMs: number | null = null
    let firstInMin: number | null = null
    let lastOutMin: number | null = null
    const intervals: { inMs: number; outMs: number }[] = []

    for (const e of dayEntries) {
      const inMs = new Date(e.clock_in).getTime()
      const outMs = new Date(e.clock_out as string).getTime()
      if (outMs <= inMs) continue
      intervals.push({ inMs, outMs })
      if (prevOutMs !== null && inMs > prevOutMs) gaps.push((inMs - prevOutMs) / 60000)
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

    // Time off the clock between entries. A rest of 20 minutes or less is
    // hours worked, and so is a meal period shorter than an hour, up to the
    // one scheduled (IRR Book III, Rule I, Sec. 7): both are credited. A
    // longer gap is the unpaid meal break, taken off the clock (the break is
    // deducted only for what it doesn't cover), or time not worked.
    const shortRests = gaps.filter((g) => g <= REST_PERIOD_MINUTES).reduce((s, g) => s + g, 0)
    const longGaps = gaps.filter((g) => g > REST_PERIOD_MINUTES)
    const paidMeal = breakMinutes > 0 ? 0 : Math.min(scheduledBreak, Math.max(0, ...longGaps))
    rawMinutes += shortRests + paidMeal
    const effectiveBreak = Math.max(0, breakMinutes - longGaps.reduce((s, g) => s + g, 0))
    // the break is taken on a day of 6 hours or more — or on a shorter shift
    // that schedules one, once its span is worked (as its expected hours count it)
    const breakAfter = shift && breakMinutes > 0 ? Math.min(6 * 60, shiftSpan(shift)) : 6 * 60
    const netMinutes =
      rawMinutes >= breakAfter ? Math.max(0, rawMinutes - effectiveBreak) : rawMinutes
    ndMinutes = Math.min(ndMinutes, netMinutes)

    const worked = netMinutes > 0
    const leave = leaveFor(date)

    // a time in inside the grace period is paid as if on time
    const lateBy = worked && dayType === 'regular' && shift && firstInMin !== null ? firstInMin - (schedStart + flex) : 0
    const forgiven = lateBy > 0 && lateBy <= gracePeriodMinutes ? lateBy : 0
    const payableMinutes = Math.min(netMinutes + forgiven, regularCap)
    const otMinutes = Math.max(0, netMinutes - regularCap)

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
    if (worked && dayType === 'regular' && shift) {
      // a flexible start is on time anywhere in its window, and the end moves with it
      const start = firstInMin === null ? schedStart : Math.min(Math.max(firstInMin, schedStart), schedStart + flex)
      const end = start + (schedEnd - schedStart)
      if (firstInMin !== null && firstInMin > schedStart + flex + gracePeriodMinutes) {
        lateMinutes = Math.round(firstInMin - (schedStart + flex))
      }
      if (lastOutMin !== null && lastOutMin < end) {
        undertimeMinutes = Math.round(end - lastOutMin)
      }
      // Deduct exactly the true hours shortfall: an employee who completed
      // the shift's hours (even shifted, or with early clock-in covering a
      // late departure) owes nothing; a short day is docked exactly the
      // unworked portion — including interior off-the-clock gaps beyond the
      // scheduled break, which edge-based late/undertime cannot see.
      const maxDeduct = Math.max(0, Math.round(expectedMinutes - payableMinutes))
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
      expectedMinutes,
      shift,
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
      leaveCode: !worked && leave ? leave.type_code : undefined,
    })
  }
  return out
}
