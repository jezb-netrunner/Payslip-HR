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

describe('review of 2026-11-06: periods, opening balances, warnings', () => {
  beforeEach(() => resetDb())
  const opening = (ent: Row, e: Row, over: Row) =>
    db.t.employee_opening_balances.push({ ...blankOpening(e.id, 2026, '2026-09-30'), id: newId(), entity_id: ent.id, ...over })

  it('a 26th-to-10th cutoff is one period, not the two calendar halves it touches', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 60000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-09-26', '2026-10-25')
    const first = await run(ent, { period_start: '2026-09-26', period_end: '2026-10-10', pay_date: '2026-10-15' }, commission(ent, e, 40000))
    const slip = slipsOf(first.id, e.id)[0]
    expect(slip.computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 1 })
    expect(slip.withholding_tax).toBe(13006.2)
    const second = await run(ent, { period_start: '2026-10-11', period_end: '2026-10-25', pay_date: '2026-10-30' })
    expect(slipsOf(second.id, e.id)[0].computation_trace.tax.periods).toBe(2)
  })

  it('a previous employer without an end date counts up to the eve of the hire here', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 40000, hire_date: '2026-07-01' })
    addAttendance(e, '2026-10-01', '2026-10-15')
    db.t.employee_tax_years.push({
      id: newId(), employee_id: e.id, entity_id: ent.id, year: 2026, has_previous_employer: true,
      prev_employment_from: '2026-01-01', prev_employment_to: null,
      prev_taxable_basic: 200000, prev_taxable_13th_other_benefits: 0, prev_taxable_other: 0, prev_tax_withheld: 9000,
      prev_mwe_exempt: 0, prev_13th_other_benefits_exempt: 0, prev_de_minimis: 0, prev_contributions: 0, prev_other_non_taxable: 0,
    })
    const r = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const slip = slipsOf(r.id, e.id)[0]
    // January–June (12 halves) + 1–15 October: not 1 + 1, which withheld ₱40,099 on ₱20,000
    expect(slip.computation_trace.tax.periods).toBe(13)
    expect(slip.withholding_tax).toBeLessThan(5000)
  })

  it('the old payroll\'s own period count replaces the calendar count', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 60000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-10-15')
    // it also paid last year's 16–31 December in January: 19 + 1
    opening(ent, e, { basic_salary: 540000, contributions: 31050, tax_withheld: 82000, thirteenth_basis: 540000, periods_paid: 20 })
    const r = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' }, commission(ent, e, 40000))
    expect(slipsOf(r.id, e.id)[0].computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 21 })
  })

  it('the 13th month deducts this year\'s advance only, not last year\'s 13th month paid in January', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-11-30')
    // ₱30,000 13th month released in 2026 = 2025's, paid 10 January; basic Jan–Sep ₱270,000
    opening(ent, e, { basic_salary: 270000, thirteenth_month: 30000, thirteenth_basis: 270000, contributions: 20000, tax_withheld: 9000 })
    for (const [s0, e0, pay] of [['2026-10-01', '2026-10-15', '2026-10-20'], ['2026-10-16', '2026-10-31', '2026-11-05'], ['2026-11-01', '2026-11-15', '2026-11-20'], ['2026-11-16', '2026-11-30', '2026-12-05']]) {
      await run(ent, { period_start: s0, period_end: e0, pay_date: pay })
    }
    const t13 = await run(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10' })
    // (270,000 + 4 × 15,000) / 12
    expect(slipsOf(t13.id, e.id)[0].gross_pay).toBe(27500)
  })

  it('says when the opening balances leave the 13th month basis out', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-10-31')
    opening(ent, e, { basic_salary: 270000, contributions: 20000, tax_withheld: 9000 })
    await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const t13 = await run(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10' })
    expect(warned(slipsOf(t13.id, e.id)[0], 'no "basic salary earned, for the 13th month"')).toBe(true)
  })

  it('warns about pay between the opening balances and the first payroll in the app', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-10-01', '2026-10-15')
    opening(ent, e, { paid_through: '2026-08-31', basic_salary: 240000, thirteenth_basis: 240000 })
    const r = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    expect(warned(slipsOf(r.id, e.id)[0], 'pay released in between is in neither')).toBe(true)
  })

  it('an opening that doesn\'t apply to this payroll says so once', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 60000, hire_date: '2024-01-01' })
    addAttendance(e, '2026-09-16', '2026-09-30')
    opening(ent, e, { paid_through: '2026-10-05', basic_salary: 540000 })
    const r = await run(ent, { period_start: '2026-09-16', period_end: '2026-09-30', pay_date: '2026-10-05' }, commission(ent, e, 40000))
    const slip = slipsOf(r.id, e.id)[0]
    expect(warned(slip, 'opening balances are left out')).toBe(true)
    expect(warned(slip, 'no opening balances are entered')).toBe(false)
  })

  it('a final pay released next year for someone who left this year raises no go-live warnings', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000, hire_date: '2024-01-01', separation_date: '2026-12-20', separation_reason: 'resignation' })
    addAttendance(e, '2026-12-01', '2026-12-20')
    await run(ent, { period_start: '2026-12-01', period_end: '2026-12-15', pay_date: '2026-12-20' })
    await run(ent, { period_start: '2026-12-16', period_end: '2026-12-31', pay_date: '2026-12-29' })
    const fp = addRun(ent, { run_type: 'final_pay', period_start: '2027-01-16', period_end: '2027-01-31', pay_date: '2027-02-05', employee_ids: [e.id] })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: e.id, entity_id: ent.id, kind: 'earning', label: 'Unused SIL', amount: 5000, category: 'other_taxable' })
    await computeRun(fp as never, ent as never)
    const slip = slipsOf(fp.id, e.id)[0]
    expect(warned(slip, 'no opening balances')).toBe(false)
    expect(warned(slip, 'starting mid-month')).toBe(false)
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
