// C2: the cumulative average method of withholding, once triggered, stays
// for the rest of the year — across payrolls, through the service.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { endOfMonth } from '../../lib/manila'

describe('withholding methods across a year (C2)', () => {
  beforeEach(() => resetDb())

  async function month(ent: Record<string, unknown>, mm: string, extra?: (runId: string) => void) {
    const start = `2026-${mm}-01`
    const end = endOfMonth(start)
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: start, period_end: end, pay_date: end })
    extra?.(r.id)
    await computeRun(r as never, ent as never)
    finalize(r.id)
    return db.t.payslips.filter((p) => p.payroll_run_id === r.id)
  }

  it('switches a zero-bracket employee to the cumulative average when supplementary pay comes, and keeps it', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const low = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 18000, employee_no: 'E1' })
    const high = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 60000, employee_no: 'E2', first_name: 'Ana' })
    addAttendance(low, '2026-01-01', '2026-08-31')
    addAttendance(high, '2026-01-01', '2026-08-31')
    const method = (slips: Record<string, any>[], e: Record<string, unknown>) => slips.find((p) => p.employee_id === e.id)?.computation_trace.tax
    for (const mm of ['01', '02', '03', '04', '05']) {
      const slips = await month(ent, mm)
      expect(method(slips, low).method).toBe('table')
    }
    const june = await month(ent, '06', (runId) =>
      db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: runId, employee_id: low.id, entity_id: ent.id, kind: 'earning', label: 'Overtime (June)', amount: 30000, category: 'overtime' }),
    )
    const t = method(june, low)
    expect(t).toMatchObject({ method: 'cumulative_average', periods: 6 })
    const earlier = db.t.payslips.filter((p) => p.employee_id === low.id && p.period_month < '2026-06-01')
    const lowJune = june.find((p) => p.employee_id === low.id)!
    expect(t.cumulative).toBeCloseTo(earlier.reduce((s, p) => s + Number(p.taxable_income), 0) + Number(lowJune.taxable_income), 2)
    expect(lowJune.withholding_tax).toBeGreaterThan(0)
    // July has no supplementary pay, but the method stays for the year
    const july = await month(ent, '07')
    expect(method(july, low)).toMatchObject({ method: 'cumulative_average', periods: 7 })
    // the other employee never had supplementary pay: the plain table
    expect(method(july, high).method).toBe('table')
  })

  it('puts an employee with an earlier employer this year on the cumulative average from the first payroll', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 35000, hire_date: '2026-07-01' })
    addAttendance(emp, '2026-07-01', '2026-07-31')
    db.t.employee_tax_years.push({
      id: newId(), employee_id: emp.id, entity_id: ent.id, year: 2026, has_previous_employer: true,
      prev_employment_from: '2026-01-01', prev_employment_to: '2026-06-30',
      prev_taxable_basic: 180000, prev_taxable_13th_other_benefits: 0, prev_taxable_other: 0, prev_tax_withheld: 8250.3,
      prev_mwe_exempt: 0, prev_13th_other_benefits_exempt: 0, prev_de_minimis: 0, prev_contributions: 0, prev_other_non_taxable: 0,
    })
    const [slip] = await month(ent, '07')
    expect(slip.computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 7 })
    expect(slip.computation_trace.tax.cumulative).toBeCloseTo(180000 + Number(slip.taxable_income), 2)
  })
  it("counts a December payroll released in January as the tax year's first period", async () => {
    const ent = addEntity({ default_pay_frequency: 'semi_monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'semi_monthly', monthly_rate: 40000 })
    addAttendance(emp, '2025-12-01', '2026-02-28')
    const periods: number[] = []
    for (const [start, end, pay] of [['2025-12-16', '2025-12-31', '2026-01-05'], ['2026-01-01', '2026-01-15', '2026-01-20'], ['2026-01-16', '2026-01-31', '2026-02-05']]) {
      const r = addRun(ent, { pay_frequency: 'semi_monthly', period_start: start, period_end: end, pay_date: pay })
      if (start === '2025-12-16') {
        db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Commission', amount: 30000, category: 'other_taxable', pay_item_type: 'commission' })
      }
      await computeRun(r as never, ent as never)
      finalize(r.id)
      periods.push(db.t.payslips.find((p) => p.payroll_run_id === r.id)!.computation_trace.tax.periods)
    }
    expect(periods).toEqual([1, 2, 3])
  })

  it('a payroll reopened after a later one switched methods keeps its own year to date', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 40000 })
    addAttendance(emp, '2026-01-01', '2026-07-31')
    const runs: Record<string, Record<string, any>> = {}
    for (const mm of ['01', '02', '03', '04', '05', '06', '07']) {
      const start = `2026-${mm}-01`
      runs[mm] = addRun(ent, { pay_frequency: 'monthly', period_start: start, period_end: endOfMonth(start), pay_date: endOfMonth(start) })
      if (mm === '06') {
        db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: runs[mm].id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Commission', amount: 40000, category: 'other_taxable', pay_item_type: 'commission' })
      }
      await computeRun(runs[mm] as never, ent as never)
      finalize(runs[mm].id)
    }
    const slip = () => db.t.payslips.find((p) => p.payroll_run_id === runs['03'].id)!
    const before = slip().withholding_tax
    expect(db.t.payslips.find((p) => p.payroll_run_id === runs['07'].id)!.computation_trace.tax.method).toBe('cumulative_average')
    runs['03'].status = 'draft'
    await computeRun(runs['03'] as never, ent as never)
    expect(slip().computation_trace.tax.method).toBe('table')
    expect(slip().withholding_tax).toBe(before)
  })
  it("a reopened payroll's bonus exemption ignores bonuses paid after it", async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 50000 })
    addAttendance(emp, '2026-06-01', '2026-11-30')
    const runs: Record<string, Record<string, any>> = {}
    for (const mm of ['06', '07', '08', '09', '10', '11']) {
      const start = `2026-${mm}-01`
      runs[mm] = addRun(ent, { pay_frequency: 'monthly', period_start: start, period_end: endOfMonth(start), pay_date: endOfMonth(start) })
      const bonus = mm === '06' ? 60000 : mm === '11' ? 50000 : 0
      if (bonus) {
        db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: runs[mm].id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Bonus', amount: bonus, category: 'other_benefits' })
      }
      await computeRun(runs[mm] as never, ent as never)
      finalize(runs[mm].id)
    }
    const june = () => db.t.payslips.find((p) => p.payroll_run_id === runs['06'].id)!
    const before = [june().taxable_income, june().withholding_tax]
    runs['06'].status = 'draft'
    await computeRun(runs['06'] as never, ent as never)
    expect([june().taxable_income, june().withholding_tax]).toEqual(before)
  })
})
