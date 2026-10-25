// Loads what the 1604-C alphalist and BIR Form 2316 are built from: the
// client's employees, the finalized payslips paid in the tax year, the
// previous-employer records and the minimum wage rates paid at year end.

import { getEmployees, getMinimumWages, getStatutoryTables } from '../lib/api'
import type { Entity } from '../lib/db'
import { fetchAll } from '../lib/fetchAll'
import { supabase } from '../lib/supabase'
import { buildAlphalist, type AlphalistRow, type YearEndRate } from './alphalist'
import { fetchFinalizedPayslipsForTaxYear, fetchTaxYears, retestedFact } from './service'

/**
 * The alphalist rows of a tax year (compensation paid in the year), or one
 * employee's row (their 2316, issued at final pay for an employee who
 * leaves: spec T8).
 */
export async function loadAlphalist(entity: Entity, year: number, employeeId?: string): Promise<AlphalistRow[]> {
  const [employees, payslips, taxYears, tables, mweRates, wageRows] = await Promise.all([
    getEmployees(entity.id),
    // tax year = compensation PAID in the year (pay date)
    fetchFinalizedPayslipsForTaxYear(entity.id, year),
    fetchTaxYears(entity.id, year),
    getStatutoryTables(`${year}-12-31`),
    // the rate on each minimum wage earner's payslips, latest last
    fetchAll<{ employee_id: string; pay_type: string; daily_rate: string; monthly_rate: string }>((from, to) =>
      supabase
        .from('payslips')
        .select(
          'employee_id, pay_type:employee_snapshot->>pay_type, daily_rate:employee_snapshot->>daily_rate, monthly_rate:employee_snapshot->>monthly_rate, payroll_runs!inner(status)',
        )
        .eq('entity_id', entity.id)
        .eq('is_minimum_wage_earner', true)
        .neq('run_type', 'thirteenth_month')
        .in('payroll_runs.status', ['finalized', 'paid'])
        .gte('pay_date', `${year}-01-01`)
        .lte('pay_date', `${year}-12-31`)
        .order('period_end')
        .order('id')
        .range(from, to),
    ),
    getMinimumWages(entity.minimum_wage_region),
  ])
  const yearEndRates = new Map<string, YearEndRate>()
  for (const r of mweRates) {
    yearEndRates.set(r.employee_id, {
      payType: r.pay_type === 'monthly' ? 'monthly' : 'daily',
      daily: Number(r.daily_rate) || 0,
      monthly: Number(r.monthly_rate) || 0,
    })
  }
  const slips = employeeId ? payslips.filter((p) => p.employee_id === employeeId) : payslips
  const byId = new Map(employees.map((e) => [e.id, e]))
  // each payslip's MWE status re-tested against the minimum wage now on
  // file, as the year-end adjustment did (spec T12)
  const factOf = (p: (typeof slips)[number]) => {
    const e = byId.get(p.employee_id)
    return retestedFact(p, {
      rows: wageRows,
      region: entity.minimum_wage_region ?? '',
      sector: entity.minimum_wage_sector ?? '',
      factor: Number(e?.days_per_year ?? entity.working_days_divisor),
      hazardExempt: !!e?.hazard_criteria_met && !!e?.hazard_dole_cert_ref?.trim(),
    }).fact
  }
  return buildAlphalist({
    year,
    entity,
    employees: employeeId ? employees.filter((e) => e.id === employeeId) : employees,
    payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: factOf(p) })),
    taxYears,
    annual: tables.bir_annual,
    yearEndRates,
  })
}
