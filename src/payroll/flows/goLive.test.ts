// A client starting on the app partway through a year or a month: the
// cumulative average never averages the pay the app holds over months it
// doesn't cover, and the payroll says what is missing (opening balances,
// a month's earlier payroll run elsewhere).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { blankOpening } from '../opening'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

async function run(ent: Row, over: Parameters<typeof addRun>[1], extra?: (runId: string) => void) {
  const r = addRun(ent, over)
  extra?.(r.id)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}
const commission = (ent: Row, e: Row, amount: number) => (runId: string) =>
  db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: runId, employee_id: e.id, entity_id: ent.id, kind: 'earning', label: 'Commission', amount, category: 'other_taxable', pay_item_type: 'commission' })
const warned = (slip: Row, text: string) => slip.computation_trace.warnings.some((w: string) => w.includes(text))

describe('going live mid-year without opening balances', () => {
  beforeEach(() => resetDb())

  it('the cumulative average counts the periods the app holds, not every period since January', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 60000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-10-31')
    const oct1 = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' }, commission(ent, e, 40000))
    const slip = slipsOf(oct1.id, e.id)[0]
    // ₱68,275 taxable over 19 periods since January averaged ₱3,593: nothing withheld
    expect(slip.computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 1 })
    // one period: ₱68,275 on the semi-monthly table, 4,270.70 + 25% × (68,275 − 33,333)
    expect(slip.taxable_income).toBe(68275)
    expect(slip.withholding_tax).toBe(13006.2)
    expect(warned(slip, 'no opening balances are entered')).toBe(true)
    // the next payroll counts two periods
    const oct2 = await run(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    expect(slipsOf(oct2.id, e.id)[0].computation_trace.tax.periods).toBe(2)
  })

  it('with opening balances the periods run from January and nothing is flagged', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 60000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-10-15')
    db.t.employee_opening_balances.push({
      ...blankOpening(e.id, 2026, '2026-09-30'), id: newId(), entity_id: ent.id,
      basic_salary: 540000, contributions: 31050, tax_withheld: 82000, thirteenth_basis: 540000,
    })
    const r = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' }, commission(ent, e, 40000))
    const slip = slipsOf(r.id, e.id)[0]
    expect(slip.computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 19 })
    expect(warned(slip, 'no opening balances')).toBe(false)
  })

  it('a previous employer\'s months still count, the gap before the app does not', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 40000, hire_date: '2026-07-01' })
    addAttendance(e, '2026-10-01', '2026-10-15')
    db.t.employee_tax_years.push({
      id: newId(), employee_id: e.id, entity_id: ent.id, year: 2026, has_previous_employer: true,
      prev_employment_from: '2026-01-01', prev_employment_to: '2026-06-30',
      prev_taxable_basic: 200000, prev_taxable_13th_other_benefits: 0, prev_taxable_other: 0, prev_tax_withheld: 9000,
      prev_mwe_exempt: 0, prev_13th_other_benefits_exempt: 0, prev_de_minimis: 0, prev_contributions: 0, prev_other_non_taxable: 0,
    })
    const r = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    // January–June (12 semi-monthly periods) + 1–15 October, not July–September
    expect(slipsOf(r.id, e.id)[0].computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 13 })
  })

  it('a client on the app since January is unaffected', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const e = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 18000, hire_date: '2025-05-01' })
    addAttendance(e, '2026-01-01', '2026-03-31')
    for (const mm of ['01', '02']) await run(ent, { pay_frequency: 'monthly', period_start: `2026-${mm}-01`, period_end: `2026-${mm}-28`, pay_date: `2026-${mm}-28` })
    const mar = await run(ent, { pay_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31', pay_date: '2026-03-31' }, commission(ent, e, 30000))
    const slip = slipsOf(mar.id, e.id)[0]
    expect(slip.computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 3 })
    expect(warned(slip, 'no opening balances')).toBe(false)
  })

  it('the 13th month says when basic pay before the app is missing', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000, hire_date: '2024-01-01' })
    const late = addEmployee(ent, { monthly_rate: 30000, hire_date: '2026-10-01', employee_no: 'E2', first_name: 'Lea' })
    addAttendance(e, '2026-10-01', '2026-10-31')
    addAttendance(late, '2026-10-01', '2026-10-31')
    await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    await run(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    const t13 = { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10' }
    const r = await run(ent, t13)
    expect(warned(slipsOf(r.id, e.id)[0], 'Basic pay counted from')).toBe(true)
    // hired with the first payroll in the app: nothing is missing
    expect(warned(slipsOf(r.id, late.id)[0], 'Basic pay counted from')).toBe(false)
  })
})

describe('going live mid-month', () => {
  beforeEach(() => resetDb())

  it('warns that the month\'s contributions may be taken twice', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 40000, hire_date: '2024-01-01' })
    const hired = addEmployee(ent, { monthly_rate: 40000, hire_date: '2026-10-20', employee_no: 'E2', first_name: 'Lea' })
    addAttendance(e, '2026-10-16', '2026-11-30')
    addAttendance(hired, '2026-10-20', '2026-11-30')
    const oct2 = await run(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    const slip = slipsOf(oct2.id, e.id)[0]
    // PhilHealth and Pag-IBIG for the whole month in its second payroll
    expect([slip.philhealth_ee, slip.pagibig_ee]).toEqual([1000, 200])
    expect(warned(slip, 'starting mid-month')).toBe(true)
    // hired inside the period: no earlier payroll of the month exists
    expect(warned(slipsOf(oct2.id, hired.id)[0], 'starting mid-month')).toBe(false)
    // the next month starts in the app: nothing to say
    const nov1 = await run(ent, { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' })
    expect(warned(slipsOf(nov1.id, e.id)[0], 'starting mid-month')).toBe(false)
  })
})
