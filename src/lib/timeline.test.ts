import { describe, expect, it } from 'vitest'
import { dayTimeline, minutesFrom, shiftOn, timelineWindow } from './timeline'
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

  it('marks a late arrival and overtime past the shift end', () => {
    const d = dayTimeline('2026-10-21', [{ clock_in: at('09:20'), clock_out: at('20:00') }], sched)
    expect(d.segments).toEqual([
      { kind: 'late', from: 540, to: 560 },
      { kind: 'work', from: 560, to: 1080 },
      { kind: 'overtime', from: 1080, to: 1200 },
    ])
    expect(d.late).toBe(true)
    // inside the client's grace period payroll doesn't count it late, so neither does the bar
    const g = dayTimeline('2026-10-21', [{ clock_in: at('09:04'), clock_out: at('18:00') }], sched, { graceMinutes: 5 })
    expect(g.late).toBe(false)
    expect(g.segments[0]).toEqual({ kind: 'work', from: 544, to: 1080 })
    // payroll charges no tardiness on a non-working holiday
    const h = dayTimeline('2026-10-21', [{ clock_in: at('09:30'), clock_out: at('18:00') }], sched, { holiday: true })
    expect(h.late).toBe(false)
    expect(h.segments.some((x) => x.kind === 'late')).toBe(false)
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

  it('handles overnight shifts and an entry still open', () => {
    const night: WorkSchedule = { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', break_minutes: 60 }
    expect(shiftOn('2026-10-21', night)).toEqual([1320, 1800])
    const d = dayTimeline('2026-10-21', [{ clock_in: at('22:00'), clock_out: null }], night)
    expect(d.open).toBe(true)
    expect(d.lastOut).toBeNull()
    expect(d.segments).toEqual([])
    expect(timelineWindow([d], [shiftOn('2026-10-21', night)])).toEqual([360, 1800])
  })
})
