// A client that goes live on the app mid-year: the same employee paid all
// year in the app (control) and paid January–September elsewhere with those
// months entered as opening balances must come out the same — separation
// and year-end annualization, the 13th month, the ₱90,000 exemption, the
// cumulative average method and the alphalist. Without the opening balances
// the separation payroll refunds tax that was correctly withheld (the DEMO
// client's Grace Torres).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, fetchOpeningBalances, toAnnualFact } from '../service'
import { buildAlphalist } from '../alphalist'
import { BIR_ANNUAL_2023 } from '../defaults'
import { blankOpening, OPENING_EARNINGS } from '../opening'
import { round2 } from '../types'
import { endOfMonth } from '../../lib/manila'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

async function run(ent: Row, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, over)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

/**
 * The opening balances of `emp`: what the old payroll register totals for
 * the control employee `from` (paid the same) through a pay date.
 */
function openingFromSlips(from: Row, emp: Row, year: number, paidThrough: string) {
  const o: Row = { ...blankOpening(emp.id, year, paidThrough), id: newId() }
  const slips = db.t.payslips.filter(
    (p) => p.employee_id === from.id && p.pay_date >= `${year}-01-01` && p.pay_date <= paidThrough,
  )
  for (const p of slips) {
    for (const l of p.earnings) {
      const f = OPENING_EARNINGS.find((x) => x.bir === l.bir)!
      o[f.key] = round2(o[f.key] + Number(l.amount))
    }
    o.contributions = round2(o.contributions + Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee) + Number(p.union_dues))
    o.tax_withheld = round2(o.tax_withheld + Number(p.withholding_tax))
    if (p.run_type !== 'thirteenth_month') o.thirteenth_basis = round2(o.thirteenth_basis + Number(p.basic_pay))
  }
  o.minimum_wage_earner = slips.every((p) => p.is_minimum_wage_earner)
  return o
}

function addOpening(ent: Row, o: Row) {
  db.t.employee_opening_balances.push({ ...o, entity_id: ent.id })
}

async function alphalistRow(ent: Row, emp: Row) {
  const slips = await fetchFinalizedPayslipsForTaxYear(ent.id, 2026)
  const rows = buildAlphalist({
    year: 2026,
    entity: ent as never,
    employees: db.t.employees.filter((e) => e.entity_id === ent.id) as never,
    payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })),
    taxYears: [],
    openings: await fetchOpeningBalances(ent.id, 2026),
    annual: BIR_ANNUAL_2023,
  })
  return rows.find((r) => r.employee.id === emp.id)!
}

const pick = (s: Row) => ({
  gross: s.gross,
  totalTaxable: s.totalTaxable,
  taxDue: s.taxDue,
  thirteenthOtherBenefitsExempt: s.thirteenthOtherBenefitsExempt,
  taxable13thOtherBenefits: s.taxable13thOtherBenefits,
  contributions: s.contributions,
  withheldAsAdjusted: s.withheldAsAdjusted,
  // round2 can leave -0
  variance: s.variance + 0,
})

describe('opening balances: going live mid-year', () => {
  beforeEach(() => resetDb())

  it('separation in October: annualizes the whole year with this employer, not October alone; the same 13th month and 2316', async () => {
    const grace = { monthly_rate: 25000, hire_date: '2023-09-01', separation_date: '2026-10-31', separation_reason: 'resignation' }
    // control: the whole year in the app
    const all = addEntity()
    const a = addEmployee(all, grace)
    addAttendance(a, '2026-01-01', '2026-10-31')
    for (let m = 1; m <= 9; m++) {
      const mm = String(m).padStart(2, '0')
      await run(all, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-20` })
      await run(all, { period_start: `2026-${mm}-16`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: `2026-${String(m + 1).padStart(2, '0')}-05` })
    }
    await run(all, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const aLast = await run(all, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })

    // live in October: the old payroll paid through 5 October (16–30 Sep)
    const live = addEntity({ code: 'DEMO' })
    const b = addEmployee(live, grace)
    addAttendance(b, '2026-10-01', '2026-10-31')
    await run(live, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const bLast = addRun(live, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(bLast as never, live as never)
    const slipA = slipsOf(aLast.id, a.id)[0]
    expect(slipA.computation_trace.tax.method).toBe('annualized')
    // Leaving in October with ₱22,925 taxable a month, the year's taxable
    // pay (₱229,250) is under the ₱250,000 zero bracket: the year's tax is
    // nil, and the separation refunds everything this employer withheld
    // since January — the old payroll's months included.
    const withheldJanToOct = db.t.payslips
      .filter((p) => p.employee_id === a.id && p.payroll_run_id !== aLast.id)
      .reduce((s, p) => s + Number(p.withholding_tax), 0)
    expect(slipA.withholding_tax).toBe(-round2(withheldJanToOct))
    // the bug: from October alone the separation refunds only 1–15
    // October's withholding, and the alphalist misses January–September
    const firstB = db.t.payslips.find((p) => p.employee_id === b.id && p.period_start === '2026-10-01')!
    expect(firstB.withholding_tax).toBeGreaterThan(0)
    expect(slipsOf(bLast.id, b.id)[0].withholding_tax).toBe(-firstB.withholding_tax)

    // enter January to 5 October as the control's payslips add up, and recompute
    addOpening(live, openingFromSlips(a, b, 2026, '2026-10-05'))
    await computeRun(bLast as never, live as never)
    const slipB = slipsOf(bLast.id, b.id)[0]
    expect(slipB.withholding_tax).toBe(slipA.withholding_tax)
    expect(slipB.computation_trace.notes.some((n: string) => n.includes('opening balances through'))).toBe(true)
    expect(slipB.computation_trace.warnings.some((w: string) => w.includes('Opening balances'))).toBe(false)
    finalize(bLast.id)

    // the 13th month counts the basic salary earned before go-live, and
    // re-annualizes the separated employee's year the same way
    const t13 = { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-11-10' }
    const a13 = await run(all, { ...t13, employee_ids: [a.id] })
    const b13 = await run(live, { ...t13, employee_ids: [b.id] })
    const [s13a, s13b] = [slipsOf(a13.id, a.id)[0], slipsOf(b13.id, b.id)[0]]
    expect(s13a.gross_pay).toBeGreaterThan(20000)
    expect(s13b.gross_pay).toBe(s13a.gross_pay)
    expect(s13b.withholding_tax).toBe(s13a.withholding_tax)

    // the alphalist / 2316: the same year, reconciled
    const [rowA, rowB] = [await alphalistRow(all, a), await alphalistRow(live, b)]
    expect(rowA.summary.variance + 0).toBe(0)
    expect(pick(rowB.summary)).toEqual(pick(rowA.summary))
    expect(rowB.summary.prevGross).toBe(0)
    expect(rowB.issues.filter((i) => i.includes('Opening'))).toEqual([])
  })

  it('December year-end: the ₱90,000 exemption and the cumulative average method carry the months before go-live', async () => {
    const emp = { pay_frequency: 'monthly', monthly_rate: 60000 }
    const month = (m: number) => {
      const start = `2026-${String(m).padStart(2, '0')}-01`
      const end = endOfMonth(start)
      return { pay_frequency: 'monthly', period_start: start, period_end: end, pay_date: end, ...(m === 12 ? { annualize: true } : {}) }
    }
    const pay = (ent: Row, e: Row, runId: string, label: string, amount: number, category: string, extra: Row = {}) =>
      db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: runId, employee_id: e.id, entity_id: ent.id, kind: 'earning', label, amount, category, ...extra })
    // October: a commission past the regular pay (cumulative average from
    // then on); November: a ₱20,000 bonus, ₱10,000 of it past the ₱90,000
    // exemption the June bonus left
    const extras = (ent: Row, e: Row, m: number, runId: string) => {
      if (m === 6) pay(ent, e, runId, 'Mid-year bonus', 80000, 'other_benefits')
      if (m === 10) pay(ent, e, runId, 'Commission', 70000, 'other_taxable', { pay_item_type: 'commission' })
      if (m === 11) pay(ent, e, runId, 'Bonus', 20000, 'other_benefits')
    }
    const all = addEntity({ default_pay_frequency: 'monthly' })
    const a = addEmployee(all, emp)
    addAttendance(a, '2026-01-01', '2026-12-31')
    const live = addEntity({ code: 'DEMO', default_pay_frequency: 'monthly' })
    const b = addEmployee(live, emp)
    addAttendance(b, '2026-10-01', '2026-12-31')
    // the same go-live without opening balances
    const bare = addEntity({ code: 'BARE', default_pay_frequency: 'monthly' })
    const c = addEmployee(bare, emp)
    addAttendance(c, '2026-10-01', '2026-12-31')
    const slips: Record<string, Row[]> = { a: [], b: [], c: [] }
    for (let m = 1; m <= 12; m++) {
      const ra = addRun(all, month(m))
      extras(all, a, m, ra.id)
      await computeRun(ra as never, all as never)
      finalize(ra.id)
      slips.a.push(slipsOf(ra.id, a.id)[0])
      if (m === 9) addOpening(live, openingFromSlips(a, b, 2026, '2026-09-30'))
      if (m < 10) continue
      for (const [ent, e, key] of [[live, b, 'b'], [bare, c, 'c']] as const) {
        const r = addRun(ent, month(m))
        extras(ent, e, m, r.id)
        await computeRun(r as never, ent as never)
        finalize(r.id)
        slips[key].push(slipsOf(r.id, e.id)[0])
      }
    }
    const opening = db.t.employee_opening_balances[0]
    expect(opening.other_benefits).toBe(80000)
    // October onward, month by month: the same taxable pay and withholding
    for (const i of [0, 1, 2]) {
      const [sa, sb] = [slips.a[9 + i], slips.b[i]]
      expect([sb.period_start, sb.taxable_income, sb.withholding_tax]).toEqual([sa.period_start, sa.taxable_income, sa.withholding_tax])
      expect(sb.computation_trace.tax.method).toBe(sa.computation_trace.tax.method)
    }
    expect(slips.b[0].computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 10 })
    expect(slips.b[0].computation_trace.tax.cumulative).toBe(slips.a[9].computation_trace.tax.cumulative)
    // November's bonus: ₱10,000 taxable because of June's bonus before go-live
    expect(slips.b[1].computation_trace.notes.some((n: string) => n.includes('₱10,000 of this payroll'))).toBe(true)
    // December's annualization withholds what the year still owes...
    expect(slips.b[2].computation_trace.tax.method).toBe('annualized')
    expect(slips.b[2].withholding_tax).toBeGreaterThan(0)
    // ...where October onward alone looks like a ₱240,000 year: the
    // cumulative average counts October's periods only (no dilution), but
    // December's annualization refunds all of it, and each payroll says the
    // months before the app are missing
    expect(slips.c[0].computation_trace.tax).toMatchObject({ method: 'cumulative_average', periods: 1 })
    expect(slips.c[0].withholding_tax).toBeGreaterThan(20000)
    expect(slips.c[2].withholding_tax).toBe(-round2(slips.c[0].withholding_tax + slips.c[1].withholding_tax))
    for (const p of slips.c) expect(p.computation_trace.warnings.some((w: string) => w.includes('no opening balances are entered'))).toBe(true)
    for (const p of slips.b) expect(p.computation_trace.warnings.some((w: string) => w.includes('no opening balances'))).toBe(false)
    expect(slips.c[1].taxable_income).toBeLessThan(slips.b[1].taxable_income)
    const [rowA, rowB] = [await alphalistRow(all, a), await alphalistRow(live, b)]
    expect(rowA.summary.taxable13thOtherBenefits).toBe(10000)
    expect(rowA.summary.variance + 0).toBe(0)
    expect(pick(rowB.summary)).toEqual(pick(rowA.summary))
  })

  it('separation after an old payroll that left a bonus\'s excess for year-end: withholds the shortfall, refunds nothing', async () => {
    const ent = addEntity({ code: 'DEMO' })
    const e = addEmployee(ent, { monthly_rate: 50000, separation_date: '2026-10-31', separation_reason: 'resignation' })
    addAttendance(e, '2026-10-01', '2026-10-31')
    await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const last = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(last as never, ent as never)
    const first = db.t.payslips.find((p) => p.employee_id === e.id && p.period_start === '2026-10-01')!
    // October alone: the separation refunds 1–15 October's tax
    expect(slipsOf(last.id, e.id)[0].withholding_tax).toBe(-first.withholding_tax)
    // January–September: ₱50,000 a month (₱3,200 contributions, ₱4,568.40
    // withheld on the monthly table), a ₱150,000 June bonus whose ₱60,000
    // excess the old payroll left for December
    addOpening(ent, {
      ...blankOpening(e.id, 2026, '2026-10-05'), id: newId(),
      basic_salary: 450000, other_benefits: 150000, contributions: 28800, tax_withheld: 41115.6, thirteenth_basis: 450000,
    })
    await computeRun(last as never, ent as never)
    const slip = slipsOf(last.id, e.id)[0]
    expect(slip.computation_trace.tax.method).toBe('annualized')
    expect(slip.withholding_tax).toBeGreaterThan(0)
    finalize(last.id)
    const row = await alphalistRow(ent, e)
    const october = db.t.payslips.filter((p) => p.employee_id === e.id).reduce((s, p) => s + Number(p.taxable_income), 0)
    // the old payroll's ₱421,200 taxable pay plus the ₱60,000 excess, plus October
    expect(row.summary.totalTaxable).toBe(round2(421200 + 60000 + october))
    expect(row.summary.taxable13thOtherBenefits).toBe(60000)
    expect(row.summary.withheldAsAdjusted).toBe(row.summary.taxDue)
    expect(row.summary.variance + 0).toBe(0)
  })

  it('warns when a payroll in the app is paid on or before the opening balances\' last pay date', async () => {
    const ent = addEntity()
    const e = addEmployee(ent, { monthly_rate: 30000 })
    addAttendance(e, '2026-09-16', '2026-10-15')
    addOpening(ent, { ...blankOpening(e.id, 2026, '2026-10-05'), id: newId(), basic_salary: 270000, contributions: 20000, tax_withheld: 9000, thirteenth_basis: 270000 })
    // 16–30 Sep paid 5 Oct: the old payroll already paid it
    const sep = await run(ent, { period_start: '2026-09-16', period_end: '2026-09-30', pay_date: '2026-10-05' })
    expect(slipsOf(sep.id, e.id)[0].computation_trace.warnings.some((w: string) => w.includes('opening balances are left out'))).toBe(true)
    const oct = await run(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    expect(slipsOf(oct.id, e.id)[0].computation_trace.warnings).toContain(
      'Opening balances cover pay through 2026-10-05, but finalized payrolls in the app were paid on 2026-10-05: that pay and tax is counted twice. Correct the "paid through" date or the opening balances (employee\'s BIR tab).',
    )
    expect((await alphalistRow(ent, e)).issues.some((i) => i.includes('counted twice'))).toBe(true)
  })
})
