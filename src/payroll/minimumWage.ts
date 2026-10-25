// The statutory minimum wage (SMW) and minimum wage earner (MWE) status
// (spec T12). Company admins keep the SMW table (`minimum_wages`: region,
// sector, daily rate, effective dates, wage order); each payroll compares
// the employee's basic rate with the SMW in force on the period's last day.

import type { AnnualPayslipFact } from './annual'
import { round2, type BirBucket } from './types'

export interface MinimumWageRow {
  id?: string
  /** Region code, as on the client's settings (PH_REGIONS). */
  region: string
  /** '' = the region's general rate; otherwise the sector the wage order names. */
  sector: string
  daily_rate: number
  effective_from: string
  /** Null: until a later rate replaces it. */
  effective_to: string | null
  wage_order_ref: string
}

// Basis: RR 2-98 §2.78.1(B)(13): the SMW is "the rate fixed by the Regional Tripartite Wage and Productivity Board". RMC 50-2018 A14.
/**
 * The SMW in force on `date` for a region and sector: the newest rate whose
 * dates cover the day — the sector's own rate first, else the region's
 * general rate (sector ''). Null when none is on file.
 */
export function minimumWageOn(rows: readonly MinimumWageRow[], region: string, sector: string, date: string): MinimumWageRow | null {
  const inForce = (s: string) =>
    rows
      .filter((r) => r.region === region && r.sector === s && r.effective_from <= date && (!r.effective_to || r.effective_to >= date))
      .reduce<MinimumWageRow | null>((best, r) => (!best || r.effective_from > best.effective_from ? r : best), null)
  return (sector ? inForce(sector) : null) ?? inForce('')
}

/** The basic daily rate compared with the SMW: daily-paid as is, monthly-paid × 12 ÷ the days-per-year factor. */
export function dailyRateOf(e: { pay_type: string; daily_rate: number | string; monthly_rate: number | string }, factor: number): number {
  return e.pay_type === 'monthly' ? round2((Number(e.monthly_rate) * 12) / factor) : round2(Number(e.daily_rate))
}

// Basis: RR 2-98 §2.78.1(B)(13): the SMW is "the rate fixed by the Regional Tripartite Wage and Productivity Board". RMC 50-2018 A14.
/** At or below the SMW: an MWE; below it: also below the minimum wage. No SMW: not an MWE. */
export function mweStatusOf(daily: number, smw: number | null): { isMwe: boolean; below: boolean } {
  if (smw === null || !(smw > 0)) return { isMwe: false, below: false }
  const rate = round2(daily)
  return { isMwe: rate <= smw, below: rate < smw }
}

const MWE_BUCKETS: readonly BirBucket[] = ['basic', 'holiday', 'overtime', 'night_diff', 'hazard', 'cola']

/**
 * A closed payslip of the year with its MWE status re-tested at the
 * year-end adjustment (a past-dated SMW changed it): the lines an MWE has
 * exempt follow the new status (hazard pay only with the criteria met,
 * spec T5). Unchanged status: the same fact.
 */
export function retestMweFact(fact: AnnualPayslipFact, isMwe: boolean, hazardExempt: boolean): AnnualPayslipFact {
  if (fact.isMwe === isMwe) return fact
  return {
    ...fact,
    isMwe,
    earnings: fact.earnings.map((l) =>
      l.bir && MWE_BUCKETS.includes(l.bir) ? { ...l, taxable: isMwe ? l.bir === 'hazard' && !hazardExempt : true } : l,
    ),
  }
}

export interface SmwClient {
  id: string
  name: string
  minimum_wage_region: string
  minimum_wage_sector: string
  working_days_divisor: number
}

export interface SmwEmployee {
  id: string
  entity_id: string
  first_name: string
  last_name: string
  pay_type: string
  daily_rate: number | string
  monthly_rate: number | string
  days_per_year: number | null
  separation_date: string | null
}

export interface SmwImpact {
  employeeId: string
  name: string
  client: string
  daily: number
  /** The SMW on the changed rate's first day, before and after the change. */
  before: number | null
  after: number | null
  /** What changes first for tax (becoming or ceasing to be an MWE), else that the rate is now below the minimum. */
  change: 'becomes_mwe' | 'no_longer_mwe' | 'below_minimum'
  /** The rate is below the new SMW: the wage order's difference is owed (WAGE_ORDER_TOPUP). */
  below: boolean
}

/**
 * Who a new or changed SMW affects (spec T12): the employees of the
 * region's clients still employed on its first day whose status changes —
 * they become MWEs, stop being MWEs, or are now below the minimum wage —
 * at their current rate. Finalized payrolls aren't changed; the year-end
 * adjustment corrects the year.
 */
export function retroactiveImpact(params: {
  before: readonly MinimumWageRow[]
  after: readonly MinimumWageRow[]
  changed: MinimumWageRow
  entities: readonly SmwClient[]
  employees: readonly SmwEmployee[]
  asOf: string
}): SmwImpact[] {
  const { before, after, changed, entities, employees } = params
  const date = changed.effective_from
  const out: SmwImpact[] = []
  for (const c of entities.filter((x) => x.minimum_wage_region === changed.region)) {
    const was = minimumWageOn(before, c.minimum_wage_region, c.minimum_wage_sector, date)?.daily_rate ?? null
    const now = minimumWageOn(after, c.minimum_wage_region, c.minimum_wage_sector, date)?.daily_rate ?? null
    if (was === now) continue
    for (const e of employees.filter((x) => x.entity_id === c.id && (!x.separation_date || x.separation_date >= date))) {
      const daily = dailyRateOf(e, Number(e.days_per_year ?? c.working_days_divisor))
      const a = mweStatusOf(daily, was)
      const b = mweStatusOf(daily, now)
      const change = b.isMwe && !a.isMwe ? 'becomes_mwe' : !b.isMwe && a.isMwe ? 'no_longer_mwe' : b.below && !a.below ? 'below_minimum' : null
      if (change) out.push({ employeeId: e.id, name: `${e.last_name}, ${e.first_name}`, client: c.name, daily, before: was, after: now, change, below: b.below })
    }
  }
  return out.sort((x, y) => x.client.localeCompare(y.client) || x.name.localeCompare(y.name))
}
