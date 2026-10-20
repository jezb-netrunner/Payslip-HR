import { describe, expect, it } from 'vitest'
import { leaveDaysInYear, leaveWorkdays } from './leave'

const MON_FRI = [1, 2, 3, 4, 5]

describe('leave days', () => {
  it('skips rest days and non-working holidays', () => {
    // Thu Dec 24 - Fri Dec 25 2026: Christmas is a regular holiday
    expect(leaveWorkdays('2026-12-24', '2026-12-25', MON_FRI, [{ holiday_date: '2026-12-25', kind: 'regular' }])).toBe(1)
    expect(leaveWorkdays('2026-12-24', '2026-12-25', MON_FRI, [{ holiday_date: '2026-12-25', kind: 'special_working' }])).toBe(2)
  })

  it('charges each year its own part of a leave across New Year', () => {
    // Wed Dec 30 2026 - Tue Jan 5 2027: 2 workdays in 2026, 2 in 2027 (Jan 1 is a holiday)
    const r = { start_date: '2026-12-30', end_date: '2027-01-05', days: 5 }
    const hols = [{ holiday_date: '2027-01-01', kind: 'regular' as const }]
    expect(leaveDaysInYear(r, 2026, MON_FRI, hols)).toBe(2)
    expect(leaveDaysInYear(r, 2027, MON_FRI, hols)).toBe(2)
    expect(leaveDaysInYear({ start_date: '2026-03-02', end_date: '2026-03-03', days: 2 }, 2026, MON_FRI)).toBe(2)
  })
})
