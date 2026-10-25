// Spec T3 end to end: the SSS base of a month comes from the pay codes of the
// lines its payrolls paid. 13th month pay (P2) is out by default; with the
// setting on, a 13th month paid before the month's last payroll is in that
// month's base, and one paid after it says the month needs recomputing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>

async function monthlyRun(ent: Row, m: number) {
  const mm = String(m).padStart(2, '0')
  const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10)
  const r = addRun(ent, { pay_frequency: 'monthly', period_start: `2026-${mm}-01`, period_end: end, pay_date: end })
  await computeRun(r as never, ent as never)
  return r
}

async function thirteenthRun(ent: Row) {
  const r = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-15', pay_date: '2026-12-15' })
  const res = await computeRun(r as never, ent as never)
  finalize(r.id as string)
  return { r, res }
}

describe('T3 flows: SSS on 13th month pay (P2)', () => {
  let ent: Row
  let emp: Row
  beforeEach(async () => {
    resetDb()
    ent = addEntity({ default_pay_frequency: 'monthly' })
    emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 20000 })
    addAttendance(emp, '2026-01-01', '2026-12-31')
    for (let m = 1; m <= 11; m++) finalize((await monthlyRun(ent, m)).id as string)
  })

  it('is out of the base by default', async () => {
    await thirteenthRun(ent)
    const dec = await monthlyRun(ent, 12)
    const [slip] = slipsOf(dec.id as string)
    expect(slip.sss_ee).toBe(1000) // MSC 20,000
  })

  it('with the setting on, a 13th month paid earlier in December is in December\'s base', async () => {
    db.t.pay_codes.find((c) => c.code === 'THIRTEENTH_MONTH')!.sss_include = true
    await thirteenthRun(ent)
    const dec = await monthlyRun(ent, 12)
    const [slip] = slipsOf(dec.id as string)
    // 20,000 + 13th month 18,333.33 = 38,333.33: the maximum MSC 35,000
    expect(slip.sss_ee).toBe(1000)
    expect(slip.sss_mpf_ee).toBe(750)
    expect(slip.computation_trace.notes.join(' ')).toContain('₱38,333.33')
  })

  it('with the setting on, a 13th month paid after the month\'s last payroll was final says to recompute that payroll', async () => {
    db.t.pay_codes.find((c) => c.code === 'THIRTEENTH_MONTH')!.sss_include = true
    finalize((await monthlyRun(ent, 12)).id as string)
    const { r } = await thirteenthRun(ent)
    const [slip] = slipsOf(r.id as string)
    expect(slip.computation_trace.warnings.join(' ')).toMatch(/December 2026.*already final.*Reopen and recompute it/)
  })
})
