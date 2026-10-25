// Spec T12 end to end: each payroll computes MWE status from the minimum
// wage table (region, sector, the period's last day), not from a checkbox;
// without a rate on file it uses the client's own setting and says so; a
// past-dated rate leaves finalized payslips alone and the year-end
// adjustment re-tests them; the client's holiday-pay setting reaches the
// payroll.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { loadAlphalist } from '../alphalistData'
import { loadMweReview } from '../mweReviewData'
import { endOfMonth } from '../../lib/manila'

type Row = Record<string, unknown>
const smw = (daily_rate: number, effective_from: string, over: Row = {}) =>
  db.t.minimum_wages.push({ id: newId(), region: 'NCR', sector: '', daily_rate, effective_from, effective_to: null, wage_order_ref: 'NCR-26', ...over })
const warningsOf = (slip: Row) => ((slip.computation_trace as Row).warnings as string[]).join(' ')

async function month(ent: Row, m: number, over: Partial<Parameters<typeof addRun>[1]> = {}, adjust?: (r: Row) => void) {
  const mm = String(m).padStart(2, '0')
  const r = addRun(ent, { pay_frequency: 'monthly', period_start: `2026-${mm}-01`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: endOfMonth(`2026-${mm}-01`), ...over })
  adjust?.(r)
  await computeRun(r as never, ent as never)
  return r
}

describe('T12 flows: computed MWE status', () => {
  beforeEach(() => resetDb())

  it('at or below the rate in force: MWE, whatever the old checkbox said; below it warns', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 600 })
    smw(695, '2025-07-17')
    const daily = { pay_type: 'daily', monthly_rate: 0, pay_frequency: 'monthly' }
    const at = addEmployee(ent, { ...daily, employee_no: 'E1', daily_rate: 695, is_minimum_wage_earner: false })
    const above = addEmployee(ent, { ...daily, employee_no: 'E2', daily_rate: 700, is_minimum_wage_earner: true })
    const below = addEmployee(ent, { ...daily, employee_no: 'E3', daily_rate: 650, is_minimum_wage_earner: false })
    for (const e of [at, above, below]) addAttendance(e, '2026-09-01', '2026-09-30')
    const r = await month(ent, 9)
    const slip = (e: Row) => slipsOf(r.id as string, e.id as string)[0]
    expect([slip(at), slip(above), slip(below)].map((s) => s.is_minimum_wage_earner)).toEqual([true, false, true])
    expect(warningsOf(slip(below))).toMatch(/Below minimum wage: the daily rate ₱650.00 is less than the minimum wage ₱695.00 \(NCR, NCR-26\)/)
    expect(warningsOf(slip(at))).not.toMatch(/Below minimum wage/)
  })

  it('no rate on file for the region and date: the client\'s own setting, and it says so', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 695 })
    const e = addEmployee(ent, { pay_type: 'daily', daily_rate: 695, monthly_rate: 0, pay_frequency: 'monthly' })
    addAttendance(e, '2026-09-01', '2026-09-30')
    const r = await month(ent, 9)
    const [slip] = slipsOf(r.id as string)
    expect(slip.is_minimum_wage_earner).toBe(true)
    expect(warningsOf(slip)).toMatch(/No minimum wage on file for NCR on Sep 30, 2026: using the client's own setting ₱695.00/)
  })

  it('a past-dated rate: finalized payslips stay as they were, the year-end adjustment re-tests them', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 645 })
    smw(645, '2025-07-17')
    const e = addEmployee(ent, { pay_type: 'daily', daily_rate: 700, monthly_rate: 0, pay_frequency: 'monthly', hire_date: '2025-01-06' })
    addAttendance(e, '2026-01-01', '2026-12-31')
    // a commission in January takes the year above the ₱250,000 of the 0% row
    const commission = (r: Row) =>
      db.t.payroll_adjustments.push({
        id: newId(), payroll_run_id: r.id, employee_id: e.id, entity_id: ent.id, kind: 'earning', label: 'Commission', amount: 150000,
        category: 'other_taxable', benefit: null, pay_code: 'COMMISSION',
      })
    for (let m = 1; m <= 11; m++) finalize((await month(ent, m, {}, m === 1 ? commission : undefined)).id as string)
    expect(db.t.payslips.every((p) => p.is_minimum_wage_earner === false)).toBe(true)
    // a ruling raises the rate from July 17
    smw(720, '2026-07-17', { wage_order_ref: 'NCR-27 (ruling)' })
    expect(db.t.payslips.every((p) => p.is_minimum_wage_earner === false)).toBe(true)
    const dec = await month(ent, 12, { pay_date: '2026-12-22', annualize: true })
    const [slip] = slipsOf(dec.id as string)
    expect(slip.is_minimum_wage_earner).toBe(true)
    expect(slip.withholding_tax as number).toBeLessThan(0)
    expect(((slip.computation_trace as Row).notes as string[]).join(' ')).toMatch(/treats 5 earlier payslips of the year as minimum wage pay/)
    finalize(dec.id as string)
    // the 2316 and the alphalist agree: July to December basic pay is the SMW box
    const [row] = await loadAlphalist(ent as never, 2026, e.id as string)
    const mweSlips = db.t.payslips.filter((p) => p.period_end >= '2026-07-17')
    const basic = mweSlips.reduce((s, p) => s + (p.earnings as Row[]).filter((l) => l.bir === 'basic').reduce((a, l) => a + Number(l.amount), 0), 0)
    const contributions = mweSlips.reduce((s, p) => s + Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee), 0)
    expect(row.summary.mweBasic).toBeCloseTo(basic - contributions, 2)
    expect(row.summary.variance).toBe(0)
  })

  it('the client\'s holiday-pay setting reaches the payroll', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_daily: 645, holiday_pay_after_absence: 'pay_anyway' })
    smw(645, '2025-07-17')
    const e = addEmployee(ent, { pay_type: 'daily', daily_rate: 700, monthly_rate: 0, pay_frequency: 'monthly' })
    db.t.holidays.push({ id: newId(), entity_id: null, holiday_date: '2026-08-31', name: 'National Heroes Day', kind: 'regular' })
    // absent Friday Aug 28, the workday before
    addAttendance(e, '2026-08-01', '2026-08-27')
    const r = await month(ent, 8)
    const [slip] = slipsOf(r.id as string)
    expect((slip.earnings as Row[]).find((l) => l.code === 'holiday')?.amount).toBe(700)
  })
})

// Owner's answer to the T12 question (2026-10-25): MWE status follows the pay
// rate; the apprentice rule is PENDING (a setting, on by default); before
// the first payroll on the new rule admins list the employees whose status
// changes, with what the year-end adjustment will do to their tax.
describe('owner 2026-10-25: the apprentice rule and the status review', () => {
  beforeEach(() => resetDb())
  const notesOf = (slip: Row) => ((slip.computation_trace as Row).notes as string[]).join(' ')

  it('an apprentice at 75% of the minimum: an MWE while the rule is on (the payslip says it is pending), not when it is off', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 600 })
    smw(695, '2025-07-17')
    const e = addEmployee(ent, { pay_type: 'daily', daily_rate: 521.25, monthly_rate: 0, pay_frequency: 'monthly', employment_status: 'apprentice' })
    addAttendance(e, '2026-09-01', '2026-10-31')
    const sep = await month(ent, 9)
    const [on] = slipsOf(sep.id as string)
    expect(on.is_minimum_wage_earner).toBe(true)
    expect(notesOf(on)).toMatch(/Apprentice or learner paid below the minimum wage: treated as a minimum wage earner \(the apprentice rule, pending legal confirmation/)
    expect(warningsOf(on)).not.toMatch(/Below minimum wage/)
    expect((on.employee_snapshot as Row).employment_status).toBe('apprentice')
    db.t.payroll_rules[0].apprentice_mwe = false
    const oct = await month(ent, 10)
    const [off] = slipsOf(oct.id as string)
    expect(off.is_minimum_wage_earner).toBe(false)
    expect(notesOf(off)).toMatch(/not treated as a minimum wage earner \(the apprentice rule is off/)
  })

  it('the rule turned off: the year-end adjustment re-tests the year\'s apprentice payslips', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 600 })
    smw(695, '2025-07-17')
    const e = addEmployee(ent, { pay_type: 'daily', daily_rate: 521.25, monthly_rate: 0, pay_frequency: 'monthly', employment_status: 'apprentice' })
    addAttendance(e, '2026-10-01', '2026-12-31')
    for (const m of [10, 11]) finalize((await month(ent, m)).id as string)
    db.t.payroll_rules[0].apprentice_mwe = false
    const dec = await month(ent, 12, { pay_date: '2026-12-22', annualize: true })
    const [slip] = slipsOf(dec.id as string)
    expect(slip.is_minimum_wage_earner).toBe(false)
    expect(notesOf(slip)).toMatch(/treats 2 earlier payslips of the year as pay that is not minimum wage pay under the minimum wage now on file for their periods and the apprentice rule/)
  })

  it('the review: who changes status against the old checkbox, and the year-end adjustment\'s catch-up tax', async () => {
    // the old rule: payroll took the checkbox; the client's own setting was 700
    const ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_region: 'NCR', minimum_wage_sector: '', minimum_wage_daily: 700 })
    const daily = { pay_type: 'daily', monthly_rate: 0, pay_frequency: 'monthly', hire_date: '2025-01-06' }
    const ticked = addEmployee(ent, { ...daily, employee_no: 'E1', last_name: 'Abad', daily_rate: 700, is_minimum_wage_earner: true })
    const fine = addEmployee(ent, { ...daily, employee_no: 'E2', last_name: 'Bello', daily_rate: 800, is_minimum_wage_earner: false })
    const below = addEmployee(ent, { ...daily, employee_no: 'E3', last_name: 'Cruz', daily_rate: 690, is_minimum_wage_earner: false })
    for (const x of [ticked, fine, below]) addAttendance(x, '2026-01-01', '2026-09-30')
    const commission = (r: Row) =>
      db.t.payroll_adjustments.push({
        id: newId(), payroll_run_id: r.id, employee_id: ticked.id, entity_id: ent.id, kind: 'earning', label: 'Commission', amount: 200000,
        category: 'other_taxable', benefit: null, pay_code: 'COMMISSION',
      })
    for (let m = 1; m <= 9; m++) finalize((await month(ent, m, {}, m === 1 ? commission : undefined)).id as string)
    // 700 a day was at the client's own minimum: paid as an MWE
    expect(db.t.payslips.filter((p) => p.employee_id === ticked.id).every((p) => p.is_minimum_wage_earner)).toBe(true)
    // payroll before the new rule took the checkbox: Cruz was paid as not an MWE
    for (const p of db.t.payslips.filter((x) => x.employee_id === below.id)) {
      p.is_minimum_wage_earner = false
      p.earnings = (p.earnings as Row[]).map((l) => (['basic', 'holiday', 'overtime', 'night_diff'].includes(l.bir as string) ? { ...l, taxable: true } : l))
    }

    // before the wage orders are entered: nothing to re-test, the status by the client's setting
    const early = await loadMweReview(ent as never, 2026, '2026-10-25')
    expect(early.rateOnFile).toBe(false)
    expect(early.untested).toBe(27)
    expect(early.rows.map((r) => [r.name, r.before, r.now])).toEqual([['Cruz, Juan', false, true]])

    // the region's wage order: 695 from July 17, 2025
    smw(695, '2025-07-17')
    const review = await loadMweReview(ent as never, 2026, '2026-10-25')
    expect(review.rateOnFile).toBe(true)
    expect(review.untested).toBe(0)
    expect(review.rows.map((r) => [r.name, r.before, r.now, r.retested])).toEqual([
      ['Abad, Juan', true, false, 9],
      ['Cruz, Juan', false, true, 9],
    ])
    const abad = review.rows[0]
    expect(abad.daily).toBe(700)
    expect(abad.taxChange).toBeGreaterThan(0)
    expect(review.rows[1].taxChange).toBe(0)
  })
})
