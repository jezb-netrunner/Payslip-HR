// The minimum wage earner status review (owner's answer to the spec T12
// question, 2026-10-25): MWE status now follows the pay rate, so before the
// first payroll on the new rule admins list the employees whose status
// changes — the status admins last set or reviewed (the old checkbox)
// against the status at today's rate and minimum wage — with what the
// year-end adjustment will do to the year's tax, so they can warn the
// employees who will owe catch-up tax.

import { summarizeYear, NO_PRIOR_EMPLOYER, type AnnualPayslipFact, type PriorEmployerInput } from './annual'
import { round2, type BirAnnualData } from './types'

export interface MweReviewEmployee {
  id: string
  first_name: string
  last_name: string
  /** The status admins last set or reviewed (before spec T12, the checkbox payroll used). */
  is_minimum_wage_earner: boolean
  /** The status at today's rate and minimum wage. */
  status: { isMwe: boolean; daily: number }
}

export interface MweReviewYear {
  /** This year's finalized payslips as paid… */
  asPaid: AnnualPayslipFact[]
  /** …and as the year-end adjustment re-tests them (the minimum wage now on file, the apprentice rule now set). */
  retested: AnnualPayslipFact[]
  prior?: PriorEmployerInput
}

export interface MweReviewRow {
  employeeId: string
  name: string
  daily: number
  before: boolean
  now: boolean
  /** This year's payslips the year-end adjustment treats under the other status. */
  retested: number
  /** The year's tax so far as the year-end adjustment computes it, less as paid: more tax (> 0) or a refund (< 0). */
  taxChange: number
}

// Basis: RR 2-98 §2.78.1(B)(13); RMC 50-2018 A14 (MWE status follows the pay rate, owner 2026-10-25). RR 2-98 §2.79(B)(5), as amended by RR 11-2018 (the year-end adjustment).
/**
 * The employees whose status changes or whose closed payslips the year-end
 * adjustment re-tests, most tax owed first. The tax change counts the
 * year's pay so far only.
 */
export function mweReview(params: {
  employees: readonly MweReviewEmployee[]
  year: ReadonlyMap<string, MweReviewYear>
  annual: BirAnnualData
}): MweReviewRow[] {
  const out: MweReviewRow[] = []
  for (const e of params.employees) {
    const y = params.year.get(e.id)
    const retested = y ? y.retested.filter((f, i) => f.isMwe !== y.asPaid[i]?.isMwe).length : 0
    if (e.is_minimum_wage_earner === e.status.isMwe && retested === 0) continue
    const due = (facts: AnnualPayslipFact[]) => summarizeYear(facts, params.annual, y?.prior ?? NO_PRIOR_EMPLOYER).taxDue
    out.push({
      employeeId: e.id,
      name: `${e.last_name}, ${e.first_name}`,
      daily: e.status.daily,
      before: e.is_minimum_wage_earner,
      now: e.status.isMwe,
      retested,
      taxChange: y && retested > 0 ? round2(due(y.retested) - due(y.asPaid)) : 0,
    })
  }
  return out.sort((a, b) => b.taxChange - a.taxChange || a.name.localeCompare(b.name))
}
