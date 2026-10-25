// Spec T8 end to end: the December year-end adjustment withholds a shortfall
// only up to net pay and the employer pays the rest (recorded at finalize as
// a paused advance to the employee, never withheld as tax later); an
// employee who leaves before December is annualized on the payroll holding
// the last day, and their 2316 is ready at final pay; a new hire without a
// previous-employer record for the year is flagged.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { loadAlphalist } from '../alphalistData'
import { endOfMonth } from '../../lib/manila'

type Row = Record<string, unknown>

async function run(ent: Row, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, { pay_frequency: 'monthly', ...over })
  await computeRun(r as never, ent as never)
  return r
}

/** A finalized payroll paid earlier in the year (January–November in one payslip). */
function paidEarlier(ent: Row, emp: Row, basic: number, withheld: number) {
  const r = addRun(ent, { pay_frequency: 'monthly', period_start: '2026-11-01', period_end: '2026-11-30', pay_date: '2026-11-30', status: 'finalized' })
  db.t.payslips.push({
    id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, run_type: 'regular',
    period_start: r.period_start, period_end: r.period_end, period_month: r.period_month, pay_date: r.pay_date, pay_frequency: 'monthly',
    is_minimum_wage_earner: false, earnings: [{ code: 'basic', label: 'Basic pay', amount: basic, bir: 'basic', taxable: true }], deductions: [],
    basic_pay: basic, gross_pay: basic, taxable_income: basic, taxable_regular: basic, taxable_supplementary: 0, wht_method: 'regular',
    sss_ee: 0, sss_mpf_ee: 0, philhealth_ee: 0, pagibig_ee: 0, union_dues: 0, withholding_tax: withheld, tax_paid_by_employer: 0, net_pay: basic - withheld,
  })
}

describe('T8 flows: year-end adjustment', () => {
  beforeEach(() => resetDb())

  it('Y1: the December shortfall past net pay is paid by the employer, recorded as a paused advance, and never withheld later', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 20000 })
    paidEarlier(ent, emp, 481700, 25000)
    addAttendance(emp, '2026-12-01', '2027-01-31')
    db.t.recurring_deductions.push({
      id: newId(), employee_id: emp.id, label: 'Company loan', category: 'company_loan', amount_per_period: 8300,
      total_amount: null, balance: null, start_date: null, end_date: null, active: true,
    })
    const dec = await run(ent, { period_start: '2026-12-01', period_end: '2026-12-31', pay_date: '2026-12-22', annualize: true })
    const [slip] = slipsOf(dec.id as string)
    expect(slip).toMatchObject({ wht_method: 'annualized', withholding_tax: 10000, tax_paid_by_employer: 7500, net_pay: 0 })
    finalize(dec.id as string)

    const advance = db.t.recurring_deductions.find((d) => d.source_run_id === dec.id)
    expect(advance).toMatchObject({ category: 'cash_advance', total_amount: 7500, balance: 7500, active: false, released_on: '2026-12-22' })
    expect(advance?.label).toBe('Tax paid by employer (2026 year-end adjustment)')

    // January: a new tax year, nothing of it withheld as tax, the advance stays paused
    const jan = await run(ent, { period_start: '2027-01-01', period_end: '2027-01-31', pay_date: '2027-01-30' })
    const [janSlip] = slipsOf(jan.id as string)
    expect(janSlip.wht_method).toBe('regular')
    expect((janSlip.deductions as Row[]).some((l) => l.meta === advance?.id)).toBe(false)
  })

  it('Y3: leaving in June: the payroll holding the last day annualizes (refund at final pay) and the 2316 is ready', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 50000, separation_date: '2026-06-15', separation_reason: 'resignation' })
    addAttendance(emp, '2026-01-01', '2026-06-15')
    for (let m = 1; m <= 5; m++) {
      const mm = String(m).padStart(2, '0')
      const r = await run(ent, { period_start: `2026-${mm}-01`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: endOfMonth(`2026-${mm}-01`) })
      finalize(r.id as string)
    }
    const june = await run(ent, { period_start: '2026-06-01', period_end: '2026-06-30', pay_date: '2026-06-30' })
    const [slip] = slipsOf(june.id as string)
    expect(slip.wht_method).toBe('annualized')
    expect(slip.withholding_tax as number).toBeLessThan(0)
    expect((slip.deductions as Row[]).find((l) => l.code === 'wht')?.label).toBe('Tax Refund (year-end adjustment)')
    finalize(june.id as string)

    const rows = await loadAlphalist(ent as never, 2026, emp.id as string)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from: '2026-01-01', to: '2026-06-15', separationCode: 'T' })
    expect(rows[0].summary.variance).toBe(0)
  })

  it('a new hire without a previous-employer record for the year is flagged; recording one clears it', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000, hire_date: '2026-09-01' })
    const old = addEmployee(ent, { employee_no: 'E2', pay_frequency: 'monthly', monthly_rate: 30000, hire_date: '2025-03-01' })
    addAttendance(emp, '2026-09-01', '2026-10-31')
    addAttendance(old, '2026-09-01', '2026-10-31')
    const sep = await run(ent, { period_start: '2026-09-01', period_end: '2026-09-30', pay_date: '2026-09-30' })
    const warnings = (id: unknown, r: Row) =>
      ((slipsOf(r.id as string, id as string)[0].computation_trace as Row).warnings as string[]).join(' ')
    expect(warnings(emp.id, sep)).toMatch(/Hired Sep 1: record under BIR data whether they had another employer earlier in 2026/)
    expect(warnings(old.id, sep)).not.toMatch(/another employer/)
    db.t.employee_tax_years.push({ id: newId(), employee_id: emp.id, entity_id: ent.id, year: 2026, has_previous_employer: false })
    const oct = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-30' })
    expect(warnings(emp.id, oct)).not.toMatch(/another employer/)
  })
})
