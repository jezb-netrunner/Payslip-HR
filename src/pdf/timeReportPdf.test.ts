import { describe, expect, it } from 'vitest'
import { eachDate, isoWeekday, manilaWallToIso } from '../lib/manila'
import { buildTimeReport, type ReportEmployee, type ReportEntry } from '../lib/timeReport'
import { buildDtrDoc, buildTimeSummaryDoc, timeReportFileName } from './timeReportPdf'

const company = { name: 'Acme Trading Corporation', registered_address: 'Makati City', tin: '123456789', tin_branch_code: '000' }

function emp(id: string, name: string): ReportEmployee {
  return {
    id,
    employee_no: id,
    first_name: name,
    middle_name: null,
    last_name: 'Reyes',
    suffix: null,
    position: 'Staff',
    department: 'Sales',
    hire_date: '2026-01-05',
    separation_date: null,
    pay_frequency: 'semi_monthly',
    work_schedule: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', break_minutes: 60 },
  }
}

// a month of work, every scheduled day, the last one overnight past midnight
function month(employeeId: string): ReportEntry[] {
  return eachDate('2026-10-01', '2026-10-31')
    .filter((d) => isoWeekday(d) <= 6)
    .map((d) => ({
      employee_id: employeeId,
      work_date: d,
      clock_in: manilaWallToIso(d, '08:00'),
      clock_out: d === '2026-10-31' ? manilaWallToIso(d, '01:00', true) : manilaWallToIso(d, '17:00'),
      flags: [],
    }))
}

const report = (employees: ReportEmployee[]) =>
  buildTimeReport({
    from: '2026-10-01',
    to: '2026-10-31',
    today: '2026-10-31',
    employees,
    entries: employees.flatMap((e) => month(e.id)),
    leaves: [],
    holidays: [],
    standardHoursPerDay: 8,
    gracePeriodMinutes: 0,
  })

const pageText = (doc: { internal: unknown }, n: number) => (doc.internal as { pages: string[][] }).pages[n].join('\n')

describe('time report PDFs', () => {
  it('prints a month of daily time records on one page per employee, in order', async () => {
    const doc = await buildDtrDoc(report([emp('A-1', 'Ana'), emp('A-2', 'Ben')]), company)
    expect(doc.getNumberOfPages()).toBe(2)
    expect(pageText(doc, 1)).toContain('Ana Reyes')
    expect(pageText(doc, 2)).toContain('Ben Reyes')
    for (const n of [1, 2]) {
      const text = pageText(doc, n)
      expect(text).toContain('DAILY TIME RECORD')
      expect(text).toContain('1:00 AM \\(+1\\)')
      expect(text).toContain('Verified by')
    }
  })

  it('summarizes everyone on one landscape table with totals', () => {
    const doc = buildTimeSummaryDoc(report([emp('A-1', 'Ana'), emp('A-2', 'Ben')]), company, '2026-10-01', '2026-10-31')
    expect(doc.internal.pageSize.getWidth()).toBeGreaterThan(doc.internal.pageSize.getHeight())
    const text = pageText(doc, 1)
    expect(text).toContain('TIME IN / OUT SUMMARY')
    expect(text).toContain('Total \\(2 employees\\)')
  })

  it('names files by client, employee and range', () => {
    expect(timeReportFileName('dtr', 'ACME', '2026-10-01', '2026-10-15', 'A/01')).toBe('dtr_ACME_A_01_2026-10-01_2026-10-15')
    expect(timeReportFileName('time_summary', 'ACME', '2026-10-01', '2026-10-15')).toBe('time_summary_ACME_2026-10-01_2026-10-15')
  })
})
