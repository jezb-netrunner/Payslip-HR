// C6 through the service: a maternity leave from March 1 to June 13. The
// maternity pay comes in March and takes the employee's shares for every
// leave month; April and May have no pay but contribute the usual amounts,
// funded by what March prepaid.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { endOfMonth } from '../../lib/manila'

describe('maternity leave months (C6)', () => {
  beforeEach(() => resetDb())

  function setup(entityOver: Record<string, unknown> = {}) {
    const ent = addEntity({ default_pay_frequency: 'monthly', ...entityOver })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000, gender: 'female' })
    const ml = { id: newId(), entity_id: null, code: 'ML', name: 'Maternity Leave (RA 11210)', paid: true }
    db.t.leave_types.push(ml)
    db.t.leave_requests.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, leave_type_id: ml.id, start_date: '2026-03-01', end_date: '2026-06-13', status: 'approved' })
    addAttendance(emp, '2026-02-01', '2026-02-28')
    addAttendance(emp, '2026-06-15', '2026-06-30')
    return { ent, emp }
  }

  async function month(ent: Record<string, unknown>, emp: Record<string, unknown>, mm: string, payout = false) {
    const start = `2026-${mm}-01`
    const end = endOfMonth(start)
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: start, period_end: end, pay_date: end })
    if (payout) {
      for (const [label, amount, benefit] of [['SSS maternity benefit', 70000, 'sss_maternity'], ['Salary differential', 35000, 'maternity_differential']] as const) {
        db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label, amount, category: 'other_non_taxable', benefit })
      }
    }
    await computeRun(r as never, ent as never)
    finalize(r.id)
    return db.t.payslips.find((p) => p.payroll_run_id === r.id && p.employee_id === emp.id)!
  }

  const contributions = (p: Record<string, number>) =>
    [p.sss_ee, p.sss_mpf_ee, p.sss_er, p.sss_mpf_er, p.sss_ec_er, p.philhealth_ee, p.philhealth_er, p.pagibig_ee, p.pagibig_er]
  const ee = (p: Record<string, number>) => Math.round((p.sss_ee + p.sss_mpf_ee + p.philhealth_ee + p.pagibig_ee) * 100) / 100

  it('contributes the usual amounts every leave month and takes the shares from the maternity pay', async () => {
    const { ent, emp } = setup()
    const feb = await month(ent, emp, '02')
    const mar = await month(ent, emp, '03', true)
    const usual = ee(feb)
    // March pays its own share from the maternity pay and prepays April to June
    const line = mar.deductions.find((l: { code: string }) => l.code === 'maternity_contributions')
    expect(line.covers.map((c: { month: string }) => c.month)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01'])
    expect(line.amount).toBe(Math.round(usual * 3 * 100) / 100)
    expect(contributions(mar)).toEqual(contributions(feb))
    const apr = await month(ent, emp, '04')
    expect(contributions(apr)).toEqual(contributions(feb))
    expect(apr.deductions.find((l: { code: string }) => l.code === 'ee_prepaid').amount).toBe(-usual)
    expect(apr.net_pay).toBe(0)
    const may = await month(ent, emp, '05')
    expect(contributions(may)).toEqual(contributions(feb))
    expect(may.net_pay).toBe(0)
    // June: back from June 15 with pay, the share was prepaid
    const jun = await month(ent, emp, '06')
    expect(jun.deductions.find((l: { code: string }) => l.code === 'ee_prepaid').amount).toBe(-usual)
  })

  it('takes the shares of leave months already paid when the maternity pay comes late', async () => {
    const { ent, emp } = setup()
    await month(ent, emp, '02')
    const mar = await month(ent, emp, '03')
    // no maternity pay yet: March's share waits for it
    expect(mar.deductions.find((l: { code: string }) => l.code === 'ee_pending').amount).toBe(-ee(mar))
    const apr = await month(ent, emp, '04', true)
    const line = apr.deductions.find((l: { code: string }) => l.code === 'maternity_contributions')
    expect(line.covers.map((c: { month: string }) => c.month)).toEqual(['2026-03-01', '2026-05-01', '2026-06-01'])
    expect(line.covers[0].amount).toBe(ee(mar))
  })

  it('at a DOLE-exempt client, flags the shares to collect instead of taking them from the SSS benefit', async () => {
    const { ent, emp } = setup({ maternity_differential_exempt: true, dole_exemption_ref: 'DOLE-CAR-2026-0042', dole_exemption_valid_until: '2026-12-31' })
    await month(ent, emp, '02')
    const apr = await month(ent, emp, '04')
    expect(apr.deductions.find((l: { code: string }) => l.code === 'ee_collect').amount).toBe(-ee(apr))
    expect(apr.computation_trace.warnings.some((w: string) => w.startsWith('Employee share to collect'))).toBe(true)
  })
})
