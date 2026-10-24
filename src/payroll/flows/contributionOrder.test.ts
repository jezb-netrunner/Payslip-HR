// Payrolls of a month finalized out of order (a late special run for days
// before a finalized closing payroll, or week 2 before week 1) must not
// deduct more than the month's contributions.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

const sumEe = (rows: Record<string, number>[]) =>
  Math.round(rows.reduce((s, p) => s + Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee), 0) * 100) / 100
const sumEr = (rows: Record<string, number>[]) =>
  Math.round(rows.reduce((s, p) => s + Number(p.sss_er) + Number(p.sss_mpf_er) + Number(p.sss_ec_er) + Number(p.philhealth_er) + Number(p.pagibig_er), 0) * 100) / 100

// ₱30,000/month: SSS EE 1,000 + MPF 500, PhilHealth EE 750, Pag-IBIG EE 200 = 2,450 EE / month
const MONTH_EE = 2450
// employer: SSS ER 2,000 + MPF 1,000 + EC 30, PhilHealth ER 750, Pag-IBIG ER 200
const MONTH_ER = 3980

describe.each(['split', 'first_period'] as const)('timing %s: earlier slot paid after the last slot', (timing) => {
  beforeEach(() => resetDb())

  it('late-entered hire: Oct 16-31 regular finalized, then a special run for Oct 5-15', async () => {
    const ent = addEntity({ contribution_deduction_timing: timing })
    // the employee record is entered after payroll 1 of October was paid
    const emp = addEmployee(ent, { hire_date: '2026-10-05' })
    addAttendance(emp, '2026-10-05', '2026-10-31')
    const reg2 = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(reg2 as never, ent as never)
    finalize(reg2.id)
    // unpaid first days, paid through a special run (index 1 of 2, October)
    const sp = addRun(ent, { run_type: 'special', period_start: '2026-10-05', period_end: '2026-10-15', pay_date: '2026-11-06' })
    await computeRun(sp as never, ent as never)
    finalize(sp.id)
    const oct = [...slipsOf(reg2.id), ...slipsOf(sp.id)]
    expect(sumEe(oct)).toBe(MONTH_EE)
    expect(sumEr(oct)).toBe(MONTH_ER)
  })

  it('weekly drafts finalized out of order (week 2 before week 1)', async () => {
    const ent = addEntity({ contribution_deduction_timing: timing, default_pay_frequency: 'weekly' })
    const emp = addEmployee(ent, { pay_frequency: 'weekly' })
    addAttendance(emp, '2026-10-01', '2026-11-01')
    // Sunday cutoffs in October 2026: 4, 11, 18, 25 -> 4 payrolls
    const weeks = [
      ['2026-09-28', '2026-10-04'],
      ['2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-18'],
      ['2026-10-19', '2026-10-25'],
    ].map(([s, e]) => addRun(ent, { pay_frequency: 'weekly', period_start: s, period_end: e, pay_date: e }))
    // week 1 is computed but held back (e.g. a disputed time entry); week 2 is finalized first
    await computeRun(weeks[0] as never, ent as never)
    await computeRun(weeks[1] as never, ent as never)
    finalize(weeks[1].id)
    // week 1 is now stale (payroll_seq moved): recompute, then finalize
    await computeRun(weeks[0] as never, ent as never)
    finalize(weeks[0].id)
    for (const w of weeks.slice(2)) {
      await computeRun(w as never, ent as never)
      finalize(w.id)
    }
    const oct = weeks.flatMap((w) => slipsOf(w.id))
    // attendance starts Oct 1, so Sep 28–30 are docked: October paid ₱25,862.07 → SSS MSC 26,000
    // (EE 1,000 + MPF 300; ER 2,000 + MPF 600 + EC 30), PhilHealth and Pag-IBIG on the rate
    expect(sumEe(oct)).toBe(2250)
    expect(sumEr(oct)).toBe(3580)
  })
})
