// Separation inside a regular run + later extras-only final pay, with the
// 13th month paid before or after the final pay: the tax year reconciles
// (alphalist variance 0) either way.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, toAnnualFact } from '../service'
import { buildAlphalist } from '../alphalist'
import { BIR_ANNUAL_2023 } from '../defaults'
import { endOfMonth } from '../../lib/manila'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, over)
  const res = await computeRun(r as never, ent as never)
  finalize(r.id)
  return { r, res }
}

async function semiMonthlyThrough(ent: Record<string, unknown>, lastMonth: number) {
  for (let m = 1; m <= lastMonth; m++) {
    const mm = String(m).padStart(2, '0')
    await runAndFinalize(ent, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-20` })
    const eom = endOfMonth(`2026-${mm}-01`)
    const nextPay = m === 12 ? '2027-01-05' : `2026-${String(m + 1).padStart(2, '0')}-05`
    await runAndFinalize(ent, { period_start: `2026-${mm}-16`, period_end: eom, pay_date: nextPay })
  }
}

async function alphalistRow(ent: Record<string, unknown>, empId: string, year: number) {
  const slips = await fetchFinalizedPayslipsForTaxYear(ent.id as string, year)
  const rows = buildAlphalist({
    year,
    entity: ent as never,
    employees: db.t.employees as never,
    payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })),
    taxYears: [],
    annual: BIR_ANNUAL_2023,
  })
  return rows.find((r) => r.employee.id === empId)!
}

describe('separation: regular run annualizes, extras-only final pay re-annualizes', () => {
  beforeEach(() => resetDb())

  it.each(['13th before final pay', '13th after final pay'])('%s', async (order) => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 50000, separation_date: '2026-11-20', separation_reason: 'resignation' })
    addAttendance(emp, '2026-01-01', '2026-11-20')
    await semiMonthlyThrough(ent, 10)
    await runAndFinalize(ent, { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' })
    // last regular payroll holds the separation date -> annualizes Juan
    const { r: last } = await runAndFinalize(ent, { period_start: '2026-11-16', period_end: '2026-11-30', pay_date: '2026-12-05' })
    const lastSlip = slipsOf(last.id, emp.id)[0]
    expect(lastSlip.computation_trace.notes.some((n: string) => n.startsWith('Annualized'))).toBe(true)

    const thirteenth = async () =>
      runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-08', employee_ids: [emp.id] })
    if (order === '13th before final pay') await thirteenth()
    const fp = addRun(ent, { run_type: 'final_pay', period_start: '2026-12-01', period_end: '2026-12-15', pay_date: '2026-12-10', employee_ids: [emp.id], annualize: true })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Separation bonus', amount: 100000, category: 'other_benefits' })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 5000, category: 'other_taxable' })
    await computeRun(fp as never, ent as never)
    finalize(fp.id)
    if (order === '13th after final pay') await thirteenth()

    const row = await alphalistRow(ent, emp.id, 2026)
    expect(row.summary.variance).toBe(0)
  })
})
