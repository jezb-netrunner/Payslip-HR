// Default year-end flow for a semi-monthly 15th/EOM client: Dec 1-15 is the
// last payroll PAID in the year (Dec 20) and annualizes; a 13th month paid
// after it (Dec 24) re-annualizes, so the year still reconciles for an
// employee over the exemption cap.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, toAnnualFact } from '../service'
import { buildAlphalist } from '../alphalist'
import { BIR_ANNUAL_2023 } from '../defaults'
import { endOfMonth } from '../../lib/manila'
import { sssCompensation } from '../engine'
import { computeSss } from '../statutory'
import { DEFAULT_TABLES } from '../defaults'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1], adj?: (runId: string) => void) {
  const r = addRun(ent, over)
  adj?.(r.id)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

describe('year-end: 13th month after the annualizing payroll', () => {
  beforeEach(() => resetDb())

  it.each(['13th first', 'annualize first'])('%s', async (order) => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 50000 })
    addAttendance(emp, '2026-01-01', '2026-12-31')
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      if (m === 12 && order === '13th first') {
        await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-18' })
      }
      await runAndFinalize(ent, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-20`, annualize: m === 12 }, (id) => {
        if (m === 6) db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Mid-year bonus', amount: 85000, category: 'other_benefits' })
      })
      if (m === 12 && order === 'annualize first') {
        await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-24' })
      }
      const nextPay = m === 12 ? '2027-01-05' : `2026-${String(m + 1).padStart(2, '0')}-05`
      await runAndFinalize(ent, { period_start: `2026-${mm}-16`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: nextPay })
    }
    const thirteenth = db.t.payslips.find((p) => p.run_type === 'thirteenth_month')!
    // paid after the annualizing payroll: the 13th month re-annualizes
    expect(thirteenth.computation_trace.notes.some((n: string) => n.startsWith('Paid after this tax year was annualized'))).toBe(
      order === 'annualize first',
    )
    const slips = await fetchFinalizedPayslipsForTaxYear(ent.id, 2026)
    const [row] = buildAlphalist({ year: 2026, entity: ent as never, employees: db.t.employees as never, payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })), taxYears: [], annual: BIR_ANNUAL_2023 })
    expect(row.summary.variance).toBe(0)
  })
  it('counts the SSS a 13th month paid after annualizing deducts', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000 })
    addAttendance(emp, '2026-01-01', '2026-12-31')
    for (let m = 1; m <= 12; m++) {
      const start = `2026-${String(m).padStart(2, '0')}-01`
      await runAndFinalize(ent, { pay_frequency: 'monthly', period_start: start, period_end: endOfMonth(start), pay_date: m === 12 ? '2026-12-23' : endOfMonth(start), annualize: m === 12 })
    }
    await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-24' })
    const thirteenth = db.t.payslips.find((p) => p.run_type === 'thirteenth_month')!
    // the month's pay reaches a higher MSC with the 13th month: SSS trues up
    expect(thirteenth.sss_mpf_ee).toBeGreaterThan(0)
    const slips = await fetchFinalizedPayslipsForTaxYear(ent.id, 2026)
    const [row] = buildAlphalist({ year: 2026, entity: ent as never, employees: db.t.employees as never, payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })), taxYears: [], annual: BIR_ANNUAL_2023 })
    expect(row.summary.variance).toBe(0)
  })
  it('a 13th month after the payroll that settled a separation trues SSS up', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 25000, separation_date: '2026-12-15', separation_reason: 'resignation' })
    addAttendance(emp, '2026-01-01', '2026-12-15')
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      await runAndFinalize(ent, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-15` })
      if (m < 12) await runAndFinalize(ent, { period_start: `2026-${mm}-16`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: endOfMonth(`2026-${mm}-01`) })
    }
    // Dec 1-15 held the last day and settled December; the 13th month comes after it
    await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-24' })
    const december = db.t.payslips.filter((p) => p.period_month === '2026-12-01')
    const due = computeSss(sssCompensation(december.flatMap((p) => p.earnings)), DEFAULT_TABLES.sss)
    const sum = (f: (p: Record<string, number>) => number) => Math.round(december.reduce((s, p) => s + f(p), 0) * 100) / 100
    expect(sum((p) => p.sss_ee + p.sss_mpf_ee)).toBe(Math.round((due.ee + due.mpfEe) * 100) / 100)
    expect(sum((p) => p.sss_er + p.sss_mpf_er + p.sss_ec_er)).toBe(Math.round((due.er + due.mpfEr + due.ecEr) * 100) / 100)
  })
})
