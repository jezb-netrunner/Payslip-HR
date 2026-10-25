// Spec T4 end to end: a client without a DOLE exemption approval for the
// payroll year must pay the maternity salary differential — the payslip
// carries an error and the run can't be finalized; with an approval for
// that year the differential may be left blank.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addRun, finalize, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>
const ERROR = 'Differential required: no DOLE exemption approval for this year'

describe('T4 flows: the differential and the client\'s DOLE exemption', () => {
  let ent: Row
  let emp: Row
  beforeEach(() => {
    resetDb()
    ent = addEntity({ default_pay_frequency: 'monthly' })
    emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000 })
    const ml = { id: newId(), entity_id: null, name: 'Maternity leave', code: 'ML', paid: true }
    db.t.leave_types.push(ml)
    db.t.leave_requests.push({
      id: newId(), entity_id: ent.id, employee_id: emp.id, leave_type_id: ml.id, start_date: '2026-03-02', end_date: '2026-06-14', status: 'approved',
    })
  })

  const march = async () => {
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31', pay_date: '2026-03-31' })
    db.t.payroll_adjustments.push({
      id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SSS maternity benefit',
      amount: 70000, category: 'other_non_taxable', benefit: 'sss_maternity', pay_code: 'MAT_SSS_BENEFIT',
    })
    await computeRun(r as never, ent as never)
    return r
  }

  it('no approval for 2026: the payslip carries the error and the run is not finalized', async () => {
    const r = await march()
    expect(slipsOf(r.id as string)[0].computation_trace.errors).toEqual([ERROR])
    expect(() => finalize(r.id as string)).toThrow(/Fix the errors/)
  })

  it('an approval for an earlier year is not enough', async () => {
    Object.assign(ent, { maternity_exemption_category: 'distressed', maternity_exemption_dole_ref: 'DOLE-2025-7', maternity_exemption_year: 2025 })
    const r = await march()
    expect(slipsOf(r.id as string)[0].computation_trace.errors).toEqual([ERROR])
  })

  it('an approval for 2026: the differential may be left blank', async () => {
    Object.assign(ent, { maternity_exemption_category: 'small_retail_service', maternity_exemption_dole_ref: 'DOLE-NCR-2026-0042', maternity_exemption_year: 2026 })
    const r = await march()
    expect(slipsOf(r.id as string)[0].computation_trace.errors).toEqual([])
    finalize(r.id as string)
  })

  it('a differential paid in an earlier payroll of the leave is enough', async () => {
    const r = await march()
    db.t.payroll_adjustments.push({
      id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Maternity salary differential',
      amount: 45000, category: 'other_taxable', benefit: 'maternity_differential', pay_code: 'MAT_DIFFERENTIAL',
    })
    await computeRun(r as never, ent as never)
    finalize(r.id as string)
    const april = addRun(ent, { pay_frequency: 'monthly', period_start: '2026-04-01', period_end: '2026-04-30', pay_date: '2026-04-30' })
    await computeRun(april as never, ent as never)
    expect(slipsOf(april.id as string)[0].computation_trace.errors).toEqual([])
  })
})
