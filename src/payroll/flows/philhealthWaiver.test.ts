// Spec T6 end to end: PhilHealth's NG share by payroll month for a solo
// parent (SPIC coverage) and a PWD (status), with the employer share
// unchanged and no PhilHealth exclusion from taxable pay in waived months.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>

async function month(ent: Row, ym: string) {
  const [y, m] = ym.split('-').map(Number)
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const r = addRun(ent, { pay_frequency: 'monthly', period_start: `${ym}-01`, period_end: end, pay_date: end })
  await computeRun(r as never, ent as never)
  const slip = slipsOf(r.id as string)[0]
  finalize(r.id as string)
  return slip
}

describe('T6 flows: the NG share', () => {
  let ent: Row
  beforeEach(() => {
    resetDb()
    ent = addEntity({ default_pay_frequency: 'monthly' })
  })

  it('P1: a solo parent from October 2026 with SPIC expiry 2027-03-15: no employee share October to February', async () => {
    const emp = addEmployee(ent, {
      pay_frequency: 'monthly', monthly_rate: 30000,
      philhealth_ee_waiver: 'solo_parent', philhealth_waiver_start_month: '2026-10-01', philhealth_spic_expiry: '2027-03-15',
    })
    addAttendance(emp, '2026-09-01', '2027-03-31')
    const slips = []
    for (const ym of ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']) slips.push(await month(ent, ym))
    expect(slips.map((p) => p.philhealth_ee)).toEqual([750, 0, 0, 0, 0, 0, 750])
    expect(new Set(slips.map((p) => p.philhealth_er))).toEqual(new Set([750]))
    // 30 days before the SPIC expires (February's payroll) and in March
    expect(slips[5].computation_trace.warnings.join(' ')).toContain('expires on Mar 15, 2027')
    expect(slips[6].computation_trace.warnings.join(' ')).toContain('No valid solo parent ID (SPIC) covers March 2027')
  })

  it('P2: a PWD for verification pays as usual; confirmed from October, new payrolls take no employee share', async () => {
    const emp = addEmployee(ent, {
      pay_frequency: 'monthly', monthly_rate: 30000,
      philhealth_ee_waiver: 'pwd', philhealth_waiver_start_month: '2026-10-01', philhealth_pwd_status: 'for_verification',
    })
    addAttendance(emp, '2026-10-01', '2026-11-30')
    const oct = await month(ent, '2026-10')
    expect(oct.philhealth_ee).toBe(750)
    emp.philhealth_pwd_status = 'confirmed'
    const nov = await month(ent, '2026-11')
    expect(nov.philhealth_ee).toBe(0)
    expect(nov.philhealth_er).toBe(750)
  })

  it('P3: in a waived month nothing is excluded from taxable pay for PhilHealth', async () => {
    const emp = addEmployee(ent, {
      pay_frequency: 'monthly', monthly_rate: 30000,
      philhealth_ee_waiver: 'pwd', philhealth_waiver_start_month: '2026-10-01', philhealth_pwd_status: 'confirmed',
    })
    addAttendance(emp, '2026-10-01', '2026-10-31')
    const oct = await month(ent, '2026-10')
    // 30,000 less SSS 1,500 and Pag-IBIG 200 only
    expect(oct.taxable_regular).toBe(28300)
  })
})
