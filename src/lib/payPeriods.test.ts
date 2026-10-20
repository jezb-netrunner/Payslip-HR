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

  it('does not drift on 28th-30th cutoffs', () => {
    // monthly 31st-30th: February clamps to the 28th, March is back on the 30th
    expect(suggestPeriod('monthly', [{ period_end: '2027-01-30' }, { period_end: '2026-12-30' }], '')).toEqual({
      start: '2027-01-31',
      end: '2027-02-28',
    })
    expect(suggestPeriod('monthly', [{ period_end: '2027-02-28' }, { period_end: '2027-01-30' }], '')).toEqual({
      start: '2027-03-01',
      end: '2027-03-30',
    })
    // semi-monthly 13th/28th is not mistaken for end of month
    expect(suggestPeriod('semi_monthly', [{ period_end: '2026-10-13' }, { period_end: '2026-09-28' }], '')).toEqual({
      start: '2026-10-14',
      end: '2026-10-28',
    })
    // semi-monthly 15th/30th survives February
    expect(
      suggestPeriod('semi_monthly', [{ period_end: '2027-03-15' }, { period_end: '2027-02-28' }, { period_end: '2027-02-15' }, { period_end: '2027-01-30' }], ''),
    ).toEqual({ start: '2027-03-16', end: '2027-03-30' })
    // end of month stays end of month
    expect(
      suggestPeriod('semi_monthly', [{ period_end: '2027-03-15' }, { period_end: '2027-02-28' }, { period_end: '2027-02-15' }, { period_end: '2027-01-31' }], ''),
    ).toEqual({ start: '2027-03-16', end: '2027-03-31' })
  })

  it('runs weekly periods back to back', () => {
    expect(suggestPeriod('weekly', [{ period_end: '2026-10-11' }], '')).toEqual({ start: '2026-10-12', end: '2026-10-18' })
  })
})

describe('payroll month slots', () => {
  it('numbers weekly periods by their cutoff within the month', () => {
    // October 2026 has five Fridays: 2, 9, 16, 23, 30
    expect(slotFor('weekly', '2026-10-16')).toEqual({ month: '2026-10-01', index: 3, count: 5 })
    // November 2026 has four Fridays: 6, 13, 20, 27
    expect(slotFor('weekly', '2026-11-27')).toEqual({ month: '2026-11-01', index: 4, count: 4 })
  })

  it('keeps every month complete when paydays move for holidays', () => {
    // Friday cutoffs: Dec 2026 has 4 (4, 11, 18, 25), Jan 2027 has 5 (1, 8, 15, 22, 29);
    // paying the Dec 25 and Jan 1 periods early doesn't move them
    expect(['2026-12-04', '2026-12-11', '2026-12-18', '2026-12-25'].map((e) => slotFor('weekly', e).index)).toEqual([1, 2, 3, 4])
    expect(slotFor('weekly', '2027-01-01')).toEqual({ month: '2027-01-01', index: 1, count: 5 })
  })

  it('splits semi-monthly by cutoff, even when the pay date spills into the next month', () => {
    expect(slotFor('semi_monthly', '2026-11-15')).toEqual({ month: '2026-11-01', index: 1, count: 2 })
    expect(slotFor('semi_monthly', '2026-11-30')).toEqual({ month: '2026-11-01', index: 2, count: 2 })
    // 10th/25th cutoffs: Feb 11-25 is February's second payroll even if paid Mar 2
    expect(slotFor('semi_monthly', '2027-02-25')).toEqual({ month: '2027-02-01', index: 2, count: 2 })
    expect(slotFor('semi_monthly', '2027-03-10')).toEqual({ month: '2027-03-01', index: 1, count: 2 })
  })
})
