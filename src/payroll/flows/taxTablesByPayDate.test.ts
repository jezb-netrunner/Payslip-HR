// Withholding and annual tables follow the PAY date (tax year), contribution
// tables the period: a Dec 16-31 payroll paid in January annualizes with
// the new year's table, the one its alphalist uses.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, toAnnualFact } from '../service'
import { buildAlphalist } from '../alphalist'
import { getStatutoryTables } from '../../lib/api'
import { BIR_ANNUAL_2023 } from '../defaults'

describe('annualization table year', () => {
  beforeEach(() => resetDb())

  it('Jan-paid separation payroll annualizes tax year 2027 with the 2026 cap', async () => {
    // hypothetical law change: cap raised to 150,000 from Jan 1, 2027
    db.t.statutory_versions.push({ id: newId(), kind: 'bir_annual', effective_from: '2027-01-01', data: { ...BIR_ANNUAL_2023, other_benefits_exemption_cap: 150000 } })
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 600000, separation_date: '2026-12-31', separation_reason: 'resignation' })
    addAttendance(emp, '2026-12-16', '2026-12-31')
    const r = addRun(ent, { period_start: '2026-12-16', period_end: '2026-12-31', pay_date: '2027-01-05' })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Bonus', amount: 140000, category: 'other_benefits' })
    await computeRun(r as never, ent as never)
    finalize(r.id)
    const tables2027 = await getStatutoryTables('2027-12-31')
    const slips = await fetchFinalizedPayslipsForTaxYear(ent.id, 2027)
    const [row] = buildAlphalist({ year: 2027, entity: ent as never, employees: db.t.employees as never, payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })), taxYears: [], annual: tables2027.bir_annual })
    expect(row.summary.variance).toBe(0)
  })
})
