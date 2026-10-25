// Spec T9: due dates. The 1601-C is due on the 10th of the next month
// (manual or eBIRForms) or on day N of the next month by eFPS group (A 15,
// B 14, C 13, D 12, E 11); December's is due January 15 (manual) or day N of
// January (eFPS). The annual dates follow the tax year. Dates never move for
// weekends or holidays: a Saturday or Sunday is marked, and the user can
// override any date with a note. SSS, PhilHealth and Pag-IBIG (P6) are a
// day-of-the-next-month setting with no default.
import { describe, expect, it } from 'vitest'
import { annualDueDates, contributionDue, due1601c, dueCalendar, isWeekend } from './dueDates'

const ALL = { sss: null, philhealth: null, pagibig: null }

describe('T9 1601-C due dates', () => {
  it('DD1: October 2026 withholding', () => {
    expect(due1601c('2026-10-01', 'manual_or_ebirforms')).toBe('2026-11-10')
    expect((['A', 'B', 'C', 'D', 'E'] as const).map((g) => due1601c('2026-10-01', 'efps', g))).toEqual([
      '2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12', '2026-11-11',
    ])
    // A falls on a Sunday and B on a Saturday: marked, not moved
    expect(['2026-11-15', '2026-11-14', '2026-11-13'].map(isWeekend)).toEqual([true, true, false])
  })

  it('DD2: December 2026 withholding', () => {
    expect(due1601c('2026-12-01', 'manual_or_ebirforms')).toBe('2027-01-15')
    expect((['A', 'B', 'C', 'D', 'E'] as const).map((g) => due1601c('2026-12-01', 'efps', g))).toEqual([
      '2027-01-15', '2027-01-14', '2027-01-13', '2027-01-12', '2027-01-11',
    ])
  })

  it('an eFPS filer without a group has no date', () => {
    expect(due1601c('2026-10-01', 'efps', null)).toBeNull()
  })
})

describe('T9 annual dates', () => {
  it('DD3: tax year 2026', () => {
    expect(annualDueDates(2026)).toEqual([
      { key: 'yea_refund', date: '2027-01-25' },
      { key: '2316_employees', date: '2027-01-31' },
      { key: '1604c', date: '2027-01-31' },
      { key: '2316_duplicates', date: '2027-02-28' },
    ])
    // the 31st and the 28th fall on Sundays: marked
    expect(['2027-01-25', '2027-01-31', '2027-02-28'].map(isWeekend)).toEqual([false, true, true])
  })
})

describe('T9 contribution dates (P6)', () => {
  it('a day of the following month, at most its last day', () => {
    expect(contributionDue('2026-10-01', 15)).toBe('2026-11-15')
    expect(contributionDue('2027-01-01', 31)).toBe('2027-02-28')
    expect(contributionDue('2026-12-01', 10)).toBe('2027-01-10')
  })
})

describe('T9 calendar', () => {
  const filing = { mode: 'efps' as const, group: 'A' as const }

  it('every month of the year and the year\'s annual dates, weekends marked', () => {
    const items = dueCalendar({ year: 2026, filing, contributionDays: ALL, overrides: [] })
    const oct = items.find((i) => i.key === '1601c' && i.period === '2026-10-01')
    expect(oct).toMatchObject({ computed: '2026-11-15', date: '2026-11-15', weekend: true, overridden: false })
    expect(items.filter((i) => i.key === '1601c')).toHaveLength(12)
    expect(items.find((i) => i.key === '1604c')).toMatchObject({ period: '2026-01-01', date: '2027-01-31', weekend: true })
    // no contribution dates without the settings
    expect(items.filter((i) => ['sss', 'philhealth', 'pagibig'].includes(i.key))).toEqual([])
  })

  it('no filing mode set: the 1601-C dates are left blank', () => {
    const items = dueCalendar({ year: 2026, filing: { mode: null, group: null }, contributionDays: ALL, overrides: [] })
    expect(items.filter((i) => i.key === '1601c').every((i) => i.date === null)).toBe(true)
  })

  it('an override replaces the date and carries its note; the computed date stays visible', () => {
    const items = dueCalendar({
      year: 2026,
      filing,
      contributionDays: ALL,
      overrides: [{ obligation: '1601c', period: '2026-10-01', due_date: '2026-11-16', note: 'RMC 95-2026 extension' }],
    })
    expect(items.find((i) => i.key === '1601c' && i.period === '2026-10-01')).toMatchObject({
      computed: '2026-11-15', date: '2026-11-16', weekend: false, overridden: true, note: 'RMC 95-2026 extension',
    })
  })

  it('contribution dates from the settings', () => {
    const items = dueCalendar({ year: 2026, filing, contributionDays: { sss: 30, philhealth: null, pagibig: 15 }, overrides: [] })
    expect(items.find((i) => i.key === 'sss' && i.period === '2026-01-01')?.date).toBe('2026-02-28')
    expect(items.find((i) => i.key === 'pagibig' && i.period === '2026-12-01')?.date).toBe('2027-01-15')
    expect(items.filter((i) => i.key === 'philhealth')).toEqual([])
  })
})
