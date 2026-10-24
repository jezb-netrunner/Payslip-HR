// Extras-only final pay (released after the last paid period):
//  (a) one-time items only — no recurring deductions (union dues, loans);
//  (b) a separation recorded after the payroll holding the last day was
//      finalized leaves the month's contributions short: the final pay
//      warns (reopening that payroll completes the month);
//  (c) carry-forward cash rounding settles to zero, never rounded down.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1], adj?: (runId: string) => void) {
  const r = addRun(ent, over)
  adj?.(r.id)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

describe('extras-only final pay', () => {
  beforeEach(() => resetDb())

  it('(a) skips recurring deductions', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { separation_date: '2026-10-15', separation_reason: 'resignation' })
    addAttendance(emp, '2026-10-01', '2026-10-15')
    db.t.recurring_deductions.push({ id: newId(), employee_id: emp.id, label: 'Union dues', category: 'union_dues', amount_per_period: 150, total_amount: null, balance: null, start_date: null, end_date: null, active: true })
    db.t.recurring_deductions.push({ id: newId(), employee_id: emp.id, label: 'Company loan', category: 'loan', amount_per_period: 2000, total_amount: 10000, balance: 6000, start_date: null, end_date: null, active: true })
    await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const fp = await runAndFinalize(ent, { run_type: 'final_pay', period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20', employee_ids: [emp.id] }, (id) => {
      db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 3000, category: 'other_taxable' })
    })
    const s = slipsOf(fp.id, emp.id)[0]
    expect(s.deductions.filter((l: { code: string }) => l.code.startsWith('other:'))).toEqual([])
  })

  it.each(['last_period', 'split'] as const)('(b) %s: separation recorded after the last day was paid — final pay warns', async (timing) => {
    const ent = addEntity({ contribution_deduction_timing: timing })
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-10-09')
    // Oct 1-15 computed and finalized before HR records the Oct 9 resignation
    await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    emp.separation_date = '2026-10-09'
    emp.separation_reason = 'resignation'
    const r2 = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(r2 as never, ent as never)
    const fp = await runAndFinalize(ent, { run_type: 'final_pay', period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20', employee_ids: [emp.id] }, (id) => {
      db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 3000, category: 'other_taxable' })
    })
    const oct = db.t.payslips.filter((p) => p.employee_id === emp.id && p.period_month === '2026-10-01')
    const ee = oct.reduce((s, p) => s + p.sss_ee + p.sss_mpf_ee + p.philhealth_ee + p.pagibig_ee, 0)
    const er = oct.reduce((s, p) => s + p.sss_er + p.sss_mpf_er + p.sss_ec_er + p.philhealth_er + p.pagibig_er, 0)
    const fps = slipsOf(fp.id, emp.id)[0]
    // October paid ₱9,482.76 (Oct 1–9 worked, Oct 12–15 docked): SSS on it is MSC 9,500 — EE 475, ER 950 + EC 10;
    // PhilHealth 750/750 and Pag-IBIG 200/200 on the rate. Split timing took half the rate-based month, so its SSS
    // was over-deducted (500 + MPF 250 against 475) while PhilHealth and Pag-IBIG are short by half.
    const short = timing === 'last_period'
      ? '₱1,425 (employee) and ₱1,910 (employer):'
      : "₱475 (employee) and ₱475 (employer), and ₱275 of the employee's SSS was over-deducted:"
    expect(ee).toBe(timing === 'last_period' ? 0 : 1225)
    expect(er).toBe(timing === 'last_period' ? 0 : 1990)
    expect(fps.computation_trace.warnings.some((w: string) => w.includes(`October 2026 contributions are short by ${short}`))).toBe(true)
  })

  it('(c) carry-forward rounding settles to zero on separation and again on the later final pay', async () => {
    const ent = addEntity({ net_pay_rounding: 'carry_forward', rounding_scope: 'cash_only' })
    const emp = addEmployee(ent, { payment_method: 'cash', pay_type: 'daily', daily_rate: 755.37, monthly_rate: 0, is_minimum_wage_earner: true, separation_date: '2026-10-28', separation_reason: 'resignation' })
    addAttendance(emp, '2026-09-01', '2026-10-28')
    const runs = [
      await runAndFinalize(ent, { period_start: '2026-09-01', period_end: '2026-09-15', pay_date: '2026-09-20' }),
      await runAndFinalize(ent, { period_start: '2026-09-16', period_end: '2026-09-30', pay_date: '2026-10-05' }),
      await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' }),
      await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' }),
      await runAndFinalize(ent, { run_type: 'final_pay', period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20', employee_ids: [emp.id] }, (id) => {
        db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 3776.85, category: 'de_minimis' })
      }),
    ]
    for (const r of runs) {
      const s = slipsOf(r.id, emp.id)[0]
      const owed = Math.round((s.gross_pay - s.total_deductions + s.rounding_carry_in) * 100)
      expect(Math.round((s.net_pay + s.rounding_carry_out) * 100)).toBeGreaterThanOrEqual(owed)
    }
    expect(emp.rounding_balance).toBe(0)
  })
})
