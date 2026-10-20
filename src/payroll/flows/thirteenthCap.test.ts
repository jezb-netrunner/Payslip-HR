// The 13th-month exemption cap is per TAX year (pay date): a 2026 13th-month
// top-up paid in January 2027 uses 2027's cap, not what 2026's bonuses used.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, toAnnualFact } from '../service'
import { summarizeYear } from '../annual'
import { BIR_ANNUAL_2023 } from '../defaults'
import { endOfMonth } from '../../lib/manila'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1], adj?: (runId: string) => void) {
  const r = addRun(ent, over)
  adj?.(r.id)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

describe('13th-month top-up paid in January', () => {
  beforeEach(() => resetDb())

  it('is exempt in its own tax year (2027) but the run withholds on it', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 100000 })
    addAttendance(emp, '2026-01-01', '2027-01-15')
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      await runAndFinalize(ent, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-20` }, (id) => {
        if (m === 6) db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'Mid-year bonus', amount: 85000, category: 'other_benefits' })
      })
      if (m === 12) {
        // 13th month on Dec 18 from basic earned through Dec 15
        await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-18' })
      }
      const nextPay = m === 12 ? '2027-01-05' : `2026-${String(m + 1).padStart(2, '0')}-05`
      await runAndFinalize(ent, { period_start: `2026-${mm}-16`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: nextPay })
    }
    // January 2027: top-up for the Dec 16-31 basic (payroll year 2026, tax year 2027)
    const topUp = await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2027-01-08' })
    const s = slipsOf(topUp.id, emp.id)[0]
    // 2027 tax-year view: the top-up is the only 13th-month/benefit paid so far
    const facts2027 = (await fetchFinalizedPayslipsForTaxYear(ent.id, 2027)).filter((p) => p.employee_id === emp.id).map(toAnnualFact)
    const y = summarizeYear(facts2027, BIR_ANNUAL_2023)
    expect(y.taxable13thOtherBenefits).toBe(0)
    expect(s.withholding_tax).toBe(0)
  })
})
