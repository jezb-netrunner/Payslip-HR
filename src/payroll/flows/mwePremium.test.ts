// Spec T5 end to end: a minimum wage earner's hazard pay follows the
// employee's hazard pay criteria and DOLE certification on file.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>

describe('T5 flows: MWE hazard pay', () => {
  let ent: Row
  let emp: Row
  beforeEach(() => {
    resetDb()
    ent = addEntity({ default_pay_frequency: 'monthly', minimum_wage_daily: 500 })
    emp = addEmployee(ent, { pay_frequency: 'monthly', pay_type: 'daily', daily_rate: 500, monthly_rate: 0, is_minimum_wage_earner: true })
    addAttendance(emp, '2026-08-01', '2026-08-31')
    db.t.employee_allowances.push({
      id: newId(), employee_id: emp.id, label: 'Hazard pay', amount: 1000, category: 'hazard', basis: 'per_period', active: true, pay_code: 'HAZARD',
    })
  })

  const hazardLine = async () => {
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: '2026-08-01', period_end: '2026-08-31', pay_date: '2026-08-31' })
    await computeRun(r as never, ent as never)
    return slipsOf(r.id as string)[0].earnings.find((l: Row) => l.payCode === 'HAZARD')
  }

  it('is taxable without the criteria and a DOLE certification', async () => {
    expect(await hazardLine()).toMatchObject({ taxable: true, incomeClass: 'supplementary' })
    emp.hazard_criteria_met = true // criteria alone are not enough
    expect(await hazardLine()).toMatchObject({ taxable: true })
  })

  it('is exempt with both on file', async () => {
    Object.assign(emp, { hazard_criteria_met: true, hazard_dole_cert_ref: 'DOLE-RO4A-HZ-2026-118' })
    expect(await hazardLine()).toMatchObject({ taxable: false })
  })
})
