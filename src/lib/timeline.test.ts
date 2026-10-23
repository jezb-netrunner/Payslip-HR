import { describe, expect, it } from 'vitest'
import { dayTimeline, minutesFrom, shiftOn, timelineTicks, timelineWindow } from './timeline'
import type { WorkSchedule } from '../payroll/types'

const sched: WorkSchedule = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 }
// 2026-10-21 is a Wednesday; Manila wall time = UTC + 8h
const at = (hhmm: string, date = '2026-10-21') => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 9, Number(date.slice(8)), h - 8, m)).toISOString()
}

describe('attendance timeline', () => {
  it('measures minutes from the Manila midnight of the work date', () => {
    expect(minutesFrom('2026-10-21', at('09:30'))).toBe(570)
    // 01:00 the next morning stays on the same work date's axis
    expect(minutesFrom('2026-10-21', at('01:00', '2026-10-22'))).toBe(1500)
  })

  it('splits a lunch-out day into work, break, work', () => {
    const d = dayTimeline(
      '2026-10-21',
      [
        { clock_in: at('09:00'), clock_out: at('12:00') },
        { clock_in: at('13:00'), clock_out: at('18:00') },
      ],
      sched,
    )
    expect(d.segments).toEqual([
      { kind: 'work', from: 540, to: 720 },
      { kind: 'break', from: 720, to: 780 },
      { kind: 'work', from: 780, to: 1080 },
    ])
    expect(d.late).toBe(false)
    expect(d.workedMinutes).toBe(480)
    expect(d.lastOut).toBe(1080)
  })

  it('shows lateness and overtime only as payroll counts them', () => {
    // a full standard day after a late start: payroll docks nothing and pays
    // the net minutes beyond the standard day (580 - 480) as overtime
    const full = dayTimeline('2026-10-21', [{ clock_in: at('09:20'), clock_out: at('20:00') }], sched)
    expect(full.late).toBe(false)
    expect(full.workedMinutes).toBe(580)
    expect(full.otMinutes).toBe(100)
    expect(full.segments).toEqual([
      { kind: 'work', from: 560, to: 1100 },
      { kind: 'overtime', from: 1100, to: 1200 },
    ])
    // shifted day, 10:00-19:00: no late, no overtime
    const shifted = dayTimeline('2026-10-21', [{ clock_in: at('10:00'), clock_out: at('19:00') }], sched)
    expect(shifted.segments).toEqual([{ kind: 'work', from: 600, to: 1140 }])
    // a short day: the late stretch is the tardiness charged
    const short = dayTimeline('2026-10-21', [{ clock_in: at('09:30'), clock_out: at('18:00') }], sched)
    expect(short.lateMinutes).toBe(30)
    expect(short.segments).toEqual([
      { kind: 'late', from: 540, to: 570 },
      { kind: 'work', from: 570, to: 1080 },
    ])
  })

  it('respects the grace period and non-working holidays', () => {
    const grace = dayTimeline('2026-10-21', [{ clock_in: at('09:04'), clock_out: at('18:00') }], sched, { graceMinutes: 5 })
    expect(grace.late).toBe(false)
    const holiday = dayTimeline('2026-10-21', [{ clock_in: at('09:30'), clock_out: at('18:00') }], sched, {
      holidays: [{ holiday_date: '2026-10-21', kind: 'special_non_working', name: 'Test day' }],
    })
    expect(holiday.late).toBe(false)
    expect(holiday.segments.some((x) => x.kind === 'late')).toBe(false)
  })

  it('draws rest-day work without late or overtime marks', () => {
    // 2026-10-25 is a Sunday
    const d = dayTimeline('2026-10-25', [{ clock_in: at('10:00', '2026-10-25'), clock_out: at('15:00', '2026-10-25') }], sched)
    expect(shiftOn('2026-10-25', sched)).toBeNull()
    expect(d.segments).toEqual([{ kind: 'work', from: 600, to: 900 }])
  })

  it('draws an entry still open today up to now without counting it as worked', () => {
    const d = dayTimeline('2026-10-21', [{ clock_in: at('09:00'), clock_out: null }], sched, { now: at('11:30') })
    expect(d.segments).toEqual([{ kind: 'work', from: 540, to: 690, live: true }])
    expect(d.workedMinutes).toBe(0)
    expect(d.open).toBe(true)
  })

  it('draws no break after a time in that never got a time out', () => {
    const d = dayTimeline(
      '2026-10-21',
      [
        { clock_in: at('09:00'), clock_out: null },
        { clock_in: at('13:00'), clock_out: at('18:00') },
      ],
      sched,
    )
    expect(d.segments.some((x) => x.kind === 'break')).toBe(false)
    expect(d.segments).toContainEqual({ kind: 'work', from: 780, to: 1080 })
  })

  it('handles overnight shifts and an entry still open', () => {
    const night: WorkSchedule = { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', break_minutes: 60 }
    expect(shiftOn('2026-10-21', night)).toEqual([1320, 1800])
    const d = dayTimeline('2026-10-21', [{ clock_in: at('22:00'), clock_out: null }], night)
    expect(d.open).toBe(true)
    expect(d.lastOut).toBeNull()
    expect(d.segments).toEqual([])
    expect(timelineWindow([d], [shiftOn('2026-10-21', night)])).toEqual([360, 1800])
  })

  it('ends the axis ticks on the window end', () => {
    expect(timelineTicks(360, 1440)).toEqual([360, 480, 600, 720, 840, 960, 1080, 1200, 1320, 1440])
    // a span over 24 hours steps by 4 hours and still labels its end
    const t = timelineTicks(360, 1920)
    expect(t[0]).toBe(360)
    expect(t[t.length - 1]).toBe(1920)
    expect(t.every((m, i) => i === 0 || m - t[i - 1] <= 240)).toBe(true)
  })
})
