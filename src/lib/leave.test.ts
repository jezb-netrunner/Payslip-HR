import { describe, expect, it } from 'vitest'
import { eligibleFrom, leaveDaysInYear, leaveWorkdays, notYetUsable, usableOn } from './leave'
import { addMonths } from './manila'

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

describe('service requirement', () => {
  const sil = { name: 'Service Incentive Leave', min_service_months: 12 }

  it('adds months like Postgres: the end of a shorter month clamps', () => {
    expect(addMonths('2026-10-23', 12)).toBe('2027-10-23')
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29')
  })

  it('opens SIL on the first anniversary; other leaves from day one', () => {
    expect(eligibleFrom(sil, '2026-10-23')).toBe('2027-10-23')
    expect(eligibleFrom({ min_service_months: 0 }, '2026-10-23')).toBeNull()
    expect(usableOn(sil, '2026-10-23', '2027-10-22', undefined)).toBe(false)
    expect(usableOn(sil, '2026-10-23', '2027-10-23', undefined)).toBe(true)
    expect(usableOn({ min_service_months: 0 }, '2026-10-23', '2026-10-23', undefined)).toBe(true)
  })

  it('credits set for the year grant it sooner; zero credits do not', () => {
    expect(usableOn(sil, '2026-10-23', '2026-12-01', 5)).toBe(true)
    expect(usableOn(sil, '2026-10-23', '2026-12-01', 0)).toBe(false)
  })

  it('says when it opens', () => {
    expect(notYetUsable(sil, '2027-10-23')).toBe('Service Incentive Leave can be used from Oct 23, 2027, after 12 months of service.')
  })
})
