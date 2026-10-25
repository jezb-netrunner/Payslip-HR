// Loads the minimum wage earner status review for one client (owner's
// answer to the spec T12 question, 2026-10-25): its employees' status now
// against the status last reviewed, and this year's finalized payslips as
// paid and as the year-end adjustment re-tests them.

import { getEmployees, getMinimumWages, getPayrollRules, getStatutoryTables } from '../lib/api'
import type { Entity } from '../lib/db'
import { todayManila } from '../lib/manila'
import { mweToday } from '../lib/useMinimumWages'
import { priorFromTaxYear } from './alphalist'
import { minimumWageOn } from './minimumWage'
import { mweReview, type MweReviewRow, type MweReviewYear } from './mweReview'
import { fetchFinalizedPayslipsForTaxYear, fetchTaxYears, retestedFact, toAnnualFact } from './service'

export interface MweReviewResult {
  rows: MweReviewRow[]
  /** A rate for the client's region is on file for today (else the client's own setting decides). */
  rateOnFile: boolean
  /** This year's payslips with no rate on file for their period: the year-end adjustment can't re-test them. */
  untested: number
  apprenticeMwe: boolean
}

export async function loadMweReview(entity: Entity, year: number, today = todayManila()): Promise<MweReviewResult> {
  const [employees, payslips, taxYears, tables, wageRows, rules] = await Promise.all([
    getEmployees(entity.id),
    fetchFinalizedPayslipsForTaxYear(entity.id, year),
    fetchTaxYears(entity.id, year),
    getStatutoryTables(`${year}-12-31`),
    getMinimumWages(entity.minimum_wage_region),
    getPayrollRules(),
  ])
  const region = entity.minimum_wage_region ?? ''
  const sector = entity.minimum_wage_sector ?? ''
  // still employed: a separated employee's year was adjusted at final pay
  const current = employees.filter((e) => !e.separation_date || e.separation_date >= today)
  const byYear = new Map<string, MweReviewYear>()
  for (const e of current) {
    const own = payslips.filter((p) => p.employee_id === e.id)
    if (own.length === 0) continue
    const ctx = {
      rows: wageRows,
      region,
      sector,
      factor: Number(e.days_per_year ?? entity.working_days_divisor),
      hazardExempt: !!e.hazard_criteria_met && !!e.hazard_dole_cert_ref?.trim(),
      apprentice: e.employment_status === 'apprentice',
      apprenticeMwe: rules.apprenticeMwe,
    }
    byYear.set(e.id, {
      asPaid: own.map(toAnnualFact),
      retested: own.map((p) => retestedFact(p, ctx).fact),
      prior: priorFromTaxYear(taxYears.find((t) => t.employee_id === e.id)),
    })
  }
  const untested = payslips.filter(
    (p) => p.run_type !== 'thirteenth_month' && !!p.period_end && !minimumWageOn(wageRows, region, sector, p.period_end),
  ).length
  return {
    rows: mweReview({
      employees: current.map((e) => ({ ...e, status: mweToday(e, entity, wageRows, { date: today, apprenticeMwe: rules.apprenticeMwe }) })),
      year: byYear,
      annual: tables.bir_annual,
    }),
    rateOnFile: !!minimumWageOn(wageRows, region, sector, today),
    untested,
    apprenticeMwe: rules.apprenticeMwe,
  }
}
