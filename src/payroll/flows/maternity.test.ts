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

  it('takes nothing for maternity from a reimbursement before the leave', async () => {
    const { ent, emp } = setup()
    const start = '2026-02-01'
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: start, period_end: endOfMonth(start), pay_date: endOfMonth(start) })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Taxi fare reimbursement', amount: 500, category: 'other_non_taxable', pay_item_type: 'liquidated_allowance' })
    await computeRun(r as never, ent as never)
    finalize(r.id)
    const feb = db.t.payslips.find((p) => p.payroll_run_id === r.id)!
    expect(feb.deductions.some((l: { code: string }) => l.code === 'maternity_contributions')).toBe(false)
    const mar = await month(ent, emp, '03')
    expect(mar.deductions.find((l: { code: string }) => l.code === 'ee_pending').amount).toBe(-ee(mar))
  })

  describe('semi-monthly', () => {
    const covers = (p: Record<string, any>) =>
      Object.fromEntries(p.deductions.find((l: { code: string }) => l.code === 'maternity_contributions').covers.map((c: { month: string; amount: number }) => [c.month, c.amount]))
    const line = (p: Record<string, any>, code: string) => p.deductions.find((l: { code: string }) => l.code === code)?.amount

    async function half(ent: Record<string, unknown>, emp: Record<string, unknown>, start: string, payout: boolean) {
      const end = start.endsWith('-01') ? `${start.slice(0, 8)}15` : endOfMonth(start)
      const r = addRun(ent, { pay_frequency: 'semi_monthly', period_start: start, period_end: end, pay_date: end })
      if (payout) {
        for (const [label, amount, benefit] of [['SSS maternity benefit', 70000, 'sss_maternity'], ['Salary differential', 35000, 'maternity_differential']] as const) {
          db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label, amount, category: 'other_non_taxable', benefit })
        }
      }
      await computeRun(r as never, ent as never)
      finalize(r.id)
      return db.t.payslips.find((p) => p.payroll_run_id === r.id)!
    }

    async function year(payout: string) {
      const ent = addEntity({ default_pay_frequency: 'semi_monthly' })
      const emp = addEmployee(ent, { pay_frequency: 'semi_monthly', monthly_rate: 30000, gender: 'female' })
      const ml = { id: newId(), entity_id: null, code: 'ML', name: 'Maternity Leave (RA 11210)', paid: true }
      db.t.leave_types.push(ml)
      db.t.leave_requests.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, leave_type_id: ml.id, start_date: '2026-03-02', end_date: '2026-06-14', status: 'approved' })
      addAttendance(emp, '2026-02-01', '2026-02-28')
      addAttendance(emp, '2026-06-15', '2026-06-30')
      const slips: Record<string, Record<string, any>> = {}
      for (const mm of ['02', '03', '04', '05', '06']) {
        for (const d of ['01', '16']) slips[`${mm}-${d}`] = await half(ent, emp, `2026-${mm}-${d}`, `2026-${mm}-${d}` === payout)
      }
      return slips
    }

    it('a payout in the first payroll of a month also takes the second payroll\'s share', async () => {
      const s = await year('2026-03-01')
      expect(Object.keys(covers(s['03-01']))).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'])
      expect(covers(s['03-01'])['2026-03-01']).toBe(ee(s['03-16']))
      for (const k of ['03-16', '04-01', '04-16', '05-01', '05-16', '06-01', '06-16']) expect(line(s[k], 'ee_prepaid')).toBe(-ee(s[k]))
      expect(s['03-16'].net_pay).toBe(0)
    })

    it('a payout in the second payroll of a month takes the first payroll\'s pending share', async () => {
      const s = await year('2026-04-16')
      expect(line(s['04-01'], 'ee_pending')).toBe(-ee(s['04-01']))
      expect(covers(s['04-16'])['2026-04-01']).toBe(ee(s['04-01']))
      expect(covers(s['04-16'])['2026-03-01']).toBe(-Math.round((line(s['03-01'], 'ee_pending') + line(s['03-16'], 'ee_pending')) * 100) / 100)
      for (const k of ['05-01', '05-16', '06-01', '06-16']) expect(line(s[k], 'ee_prepaid')).toBe(-ee(s[k]))
    })
  })

  it('at a DOLE-exempt client, flags the shares to collect instead of taking them from the SSS benefit', async () => {
    const { ent, emp } = setup({ maternity_differential_exempt: true, dole_exemption_ref: 'DOLE-CAR-2026-0042', dole_exemption_valid_until: '2026-12-31' })
    await month(ent, emp, '02')
    const apr = await month(ent, emp, '04')
    expect(apr.deductions.find((l: { code: string }) => l.code === 'ee_collect').amount).toBe(-ee(apr))
    expect(apr.computation_trace.warnings.some((w: string) => w.startsWith('Employee share to collect'))).toBe(true)
  })
})
