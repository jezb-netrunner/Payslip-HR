// Run-level warnings reach the admin: the unpaid last days of an extras-only
// final pay are stored on that payslip, and an employee left out by the
// overlap rule is reported with the run result (the run page shows every
// result warning). A left-out employee's one-time adjustment blocks
// finalize instead of being dropped silently.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

/** What PayrollRunDetail renders: every result warning plus each payslip's own. */
function visibleWarnings(res: Awaited<ReturnType<typeof computeRun>>, runId: string): string[] {
  const fromRun = res.warnings.flatMap((w) => w.warnings)
  const fromSlips = slipsOf(runId).flatMap((s) => s.computation_trace?.warnings ?? [])
  return [...fromRun, ...fromSlips]
}

describe('run-level warnings', () => {
  beforeEach(() => resetDb())

  it('extras-only final pay while the last days are unpaid: the payslip carries the warning', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { separation_date: '2026-10-20', separation_reason: 'resignation' })
    addAttendance(emp, '2026-10-01', '2026-10-20')
    const r1 = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    await computeRun(r1 as never, ent as never)
    finalize(r1.id)
    // final pay released after the last day, Oct 16-20 never paid
    const fp = addRun(ent, {
      run_type: 'final_pay', period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20',
      employee_ids: [emp.id],
    })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 2000, category: 'other_taxable' })
    const res = await computeRun(fp as never, ent as never)
    expect(visibleWarnings(res, fp.id).some((w) => w.includes('only paid through 2026-10-15'))).toBe(true)
  })

  it('final pay counts a 13th month of the separation month: no false SSS over-deduction', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { separation_date: '2026-12-15', separation_reason: 'resignation' })
    addAttendance(emp, '2026-11-01', '2026-12-15')
    for (const [start, end, pay] of [['2026-11-01', '2026-11-15', '2026-11-20'], ['2026-11-16', '2026-11-30', '2026-12-05']]) {
      const r = addRun(ent, { period_start: start, period_end: end, pay_date: pay })
      await computeRun(r as never, ent as never)
      finalize(r.id)
    }
    const t = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10', employee_ids: [emp.id] })
    await computeRun(t as never, ent as never)
    finalize(t.id)
    // the payroll holding the last day settles December's SSS on pay plus the 13th month
    const last = addRun(ent, { period_start: '2026-12-01', period_end: '2026-12-15', pay_date: '2026-12-20' })
    await computeRun(last as never, ent as never)
    finalize(last.id)
    const fp = addRun(ent, { run_type: 'final_pay', period_start: '2026-12-16', period_end: '2026-12-31', pay_date: '2026-12-23', employee_ids: [emp.id] })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 2000, category: 'other_taxable' })
    const res = await computeRun(fp as never, ent as never)
    expect(visibleWarnings(res, fp.id).filter((w) => w.includes('contributions are short') || w.includes('over-deducted'))).toEqual([])
  })

  it("left-out employee is reported and their adjustment blocks finalize", async () => {
    const ent = addEntity()
    const a = addEmployee(ent, { first_name: 'Ana', separation_date: '2026-10-20', separation_reason: 'resignation' })
    const b = addEmployee(ent, { first_name: 'Ben', employee_no: 'E2' })
    addAttendance(a, '2026-10-16', '2026-10-20')
    addAttendance(b, '2026-10-16', '2026-10-31')
    // Ana's final pay for her last days was finalized first
    const fp = addRun(ent, { run_type: 'final_pay', period_start: '2026-10-16', period_end: '2026-10-20', pay_date: '2026-10-23', employee_ids: [a.id] })
    await computeRun(fp as never, ent as never)
    finalize(fp.id)
    // the regular run carries a bonus for Ana (e.g. unpaid OT from earlier)
    const reg = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: reg.id, employee_id: a.id, entity_id: ent.id, kind: 'earning', label: 'Unpaid OT Oct 3', amount: 1500, category: 'overtime' })
    const res = await computeRun(reg as never, ent as never)
    expect(() => finalize(reg.id)).toThrow(/adjustment/i)
    const paidOt = db.t.payslips.filter((p) => p.employee_id === a.id).flatMap((p) => p.earnings).filter((l) => l.label === 'Unpaid OT Oct 3')
    expect(paidOt).toHaveLength(0)
    expect(visibleWarnings(res, reg.id).some((w) => w.includes('Left out'))).toBe(true)
  })
})
