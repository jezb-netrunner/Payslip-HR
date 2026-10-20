import { describe, expect, it } from 'vitest'
import { slotFor, suggestPeriod } from './payPeriods'

describe('pay period suggestions', () => {
  it('starts from calendar periods', () => {
    expect(suggestPeriod('semi_monthly', [], '2026-10-19')).toEqual({ start: '2026-10-16', end: '2026-10-31' })
    expect(suggestPeriod('weekly', [], '2026-10-21')).toEqual({ start: '2026-10-19', end: '2026-10-25' })
    expect(suggestPeriod('monthly', [], '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('continues calendar semi-monthly halves', () => {
    expect(suggestPeriod('semi_monthly', [{ period_end: '2026-10-15' }, { period_end: '2026-09-30' }], '')).toEqual({
      start: '2026-10-16',
      end: '2026-10-31',
    })
    expect(suggestPeriod('semi_monthly', [{ period_end: '2026-10-31' }, { period_end: '2026-10-15' }], '')).toEqual({
      start: '2026-11-01',
      end: '2026-11-15',
    })
  })

  it("keeps a client's own semi-monthly cutoffs (10th / 25th)", () => {
    expect(suggestPeriod('semi_monthly', [{ period_end: '2026-10-25' }, { period_end: '2026-10-10' }], '')).toEqual({
      start: '2026-10-26',
      end: '2026-11-10',
    })
    expect(suggestPeriod('semi_monthly', [{ period_end: '2026-11-10' }, { period_end: '2026-10-25' }], '')).toEqual({
      start: '2026-11-11',
      end: '2026-11-25',
    })
  })

  it('keeps a 26th–25th monthly cutoff and calendar months', () => {
    expect(suggestPeriod('monthly', [{ period_end: '2026-10-25' }], '')).toEqual({ start: '2026-10-26', end: '2026-11-25' })
    expect(suggestPeriod('monthly', [{ period_end: '2026-01-31' }], '')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('runs weekly periods back to back', () => {
    expect(suggestPeriod('weekly', [{ period_end: '2026-10-11' }], '')).toEqual({ start: '2026-10-12', end: '2026-10-18' })
  })
})

describe('payroll month slots', () => {
  it('numbers weekly paydays within the month', () => {
    // October 2026 has five Fridays: 2, 9, 16, 23, 30
    expect(slotFor('weekly', '2026-10-16')).toEqual({ month: '2026-10-01', index: 3, count: 5 })
    // November 2026 has four Fridays: 6, 13, 20, 27
    expect(slotFor('weekly', '2026-11-27')).toEqual({ month: '2026-11-01', index: 4, count: 4 })
  })

  it('splits semi-monthly by pay day', () => {
    expect(slotFor('semi_monthly', '2026-11-05')).toEqual({ month: '2026-11-01', index: 1, count: 2 })
    expect(slotFor('semi_monthly', '2026-11-20')).toEqual({ month: '2026-11-01', index: 2, count: 2 })
  })
})
