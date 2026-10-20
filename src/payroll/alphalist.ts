// BIR Form 1604-C alphalist rows (RMC 73-2019 / RMC 160-2022 layout:
// Schedule 1 = employees, Schedule 2 = minimum wage earners) built from a
// client's finalized payslips for a calendar year. The figures mirror BIR
// Form 2316; the payroll officer keys or imports them into the BIR
// Alphalist Data Entry and Validation Module, which produces the DAT file.

import type { Employee, EmployeeTaxYear, Entity } from '../lib/db'
import { EMPLOYMENT_STATUS_BIR, SEPARATION_REASON_BIR } from '../lib/labels'
import { NO_PRIOR_EMPLOYER, summarizeYear, type AnnualPayslipFact, type AnnualSummary, type PriorEmployerInput } from './annual'
import { round2, type BirAnnualData } from './types'

export function priorFromTaxYear(t: EmployeeTaxYear | undefined): PriorEmployerInput {
  if (!t || !t.has_previous_employer) return NO_PRIOR_EMPLOYER
  const n = (v: unknown) => Number(v ?? 0) || 0
  return {
    mweExempt: n(t.prev_mwe_exempt),
    thirteenthOtherBenefitsExempt: n(t.prev_13th_other_benefits_exempt),
    deMinimis: n(t.prev_de_minimis),
    contributions: n(t.prev_contributions),
    otherNonTaxable: n(t.prev_other_non_taxable),
    taxableBasic: n(t.prev_taxable_basic),
    taxable13thOtherBenefits: n(t.prev_taxable_13th_other_benefits),
    taxableOther: n(t.prev_taxable_other),
    taxWithheld: n(t.prev_tax_withheld),
  }
}

export interface AlphalistRow {
  schedule: 1 | 2
  employee: Employee
  summary: AnnualSummary
  /** Inclusive dates of employment within the year. */
  from: string
  to: string
  statusCode: string
  /** T / TR / R / D when separated during the year, else ''. */
  separationCode: string
  region: string
  factor: number
  smwPerDay: number
  smwPerMonth: number
  smwPerYear: number
  substitutedFiling: boolean
  prevEmployerTin: string
  prevEmployerName: string
  issues: string[]
}

export function buildAlphalist(params: {
  year: number
  entity: Entity
  employees: Employee[]
  payslips: { employee_id: string; fact: AnnualPayslipFact }[]
  taxYears: EmployeeTaxYear[]
  annual: BirAnnualData
}): AlphalistRow[] {
  const { year, entity, employees, payslips, taxYears, annual } = params
  const jan1 = `${year}-01-01`
  const dec31 = `${year}-12-31`
  const rows: AlphalistRow[] = []

  for (const e of employees) {
    const facts = payslips.filter((p) => p.employee_id === e.id).map((p) => p.fact)
    if (facts.length === 0) continue
    const ty = taxYears.find((t) => t.employee_id === e.id && t.year === year)
    const prior = priorFromTaxYear(ty)
    const summary = summarizeYear(facts, annual, prior, Number(ty?.pera_tax_credit ?? 0) || 0)

    const separatedInYear = !!e.separation_date && e.separation_date <= dec31 && e.separation_date >= jan1
    // paid this year for work before leaving last year (e.g. the Dec 16-31
    // payroll released in January): report the actual last employment span
    const separatedBefore = !!e.separation_date && e.separation_date < jan1
    const separated = separatedInYear || separatedBefore
    const spanStart = separatedBefore ? `${(e.separation_date as string).slice(0, 4)}-01-01` : jan1
    const from = e.hire_date > spanStart ? e.hire_date : spanStart
    const to = separated ? (e.separation_date as string) : dec31
    const factor = Number(e.days_per_year ?? entity.working_days_divisor)
    const smwPerDay =
      e.pay_type === 'daily' ? Number(e.daily_rate) : round2((Number(e.monthly_rate) * 12) / factor)

    const autoSubstituted =
      !ty?.has_previous_employer && !separated && summary.variance === 0
    const substitutedFiling =
      ty?.substituted_filing === 'yes' ? true : ty?.substituted_filing === 'no' ? false : autoSubstituted

    const issues: string[] = []
    if (!e.tin) issues.push('No TIN')
    if (!e.birth_date) issues.push('No birth date')
    if (!e.address || !e.zip_code) issues.push('No address/ZIP')
    if (summary.variance > 0) issues.push(`Under-withheld by ₱${summary.variance.toLocaleString()} — annualize`)
    if (summary.variance < 0) issues.push(`Over-withheld by ₱${(-summary.variance).toLocaleString()} — refund via annualization`)
    if (summary.allMwe && !entity.minimum_wage_region) issues.push('Client wage region not set')
    if (ty?.has_previous_employer && !ty.prev_employer_tin) issues.push('Previous employer TIN missing')
    if (separatedBefore) {
      issues.push(`Separated ${e.separation_date}, paid in ${year}: check the employment dates the BIR module accepts`)
    }

    rows.push({
      schedule: summary.allMwe ? 2 : 1,
      employee: e,
      summary,
      from,
      to,
      statusCode: EMPLOYMENT_STATUS_BIR[e.employment_status],
      separationCode: separated && e.separation_reason ? SEPARATION_REASON_BIR[e.separation_reason] : '',
      region: entity.minimum_wage_region,
      factor,
      smwPerDay,
      smwPerMonth: round2((smwPerDay * factor) / 12),
      smwPerYear: round2(smwPerDay * factor),
      substitutedFiling,
      prevEmployerTin: ty?.has_previous_employer ? ty.prev_employer_tin : '',
      prevEmployerName: ty?.has_previous_employer ? ty.prev_employer_name : '',
      issues,
    })
  }
  return rows.sort((a, b) =>
    `${a.employee.last_name} ${a.employee.first_name}`.localeCompare(`${b.employee.last_name} ${b.employee.first_name}`),
  )
}

/** CSV header + rows with every 2316 / alphalist figure for one schedule. */
export function alphalistCsv(rows: AlphalistRow[], schedule: 1 | 2): (string | number)[][] {
  const header = [
    'Seq', 'TIN', 'Last Name', 'First Name', 'Middle Name', 'Birth Date', 'Nationality', 'Address', 'ZIP',
    'Employment Status', 'Employed From', 'Employed To', 'Reason of Separation', 'Substituted Filing',
    ...(schedule === 2 ? ['Region', 'SMW per Day', 'SMW per Month', 'SMW per Year', 'Factor (days/yr)'] : []),
    'Gross Compensation (present)',
    'NT: Basic SMW (MWE)', 'NT: Holiday Pay (MWE)', 'NT: Overtime Pay (MWE)', 'NT: Night Shift Diff (MWE)', 'NT: Hazard Pay (MWE)',
    'NT: 13th Month & Other Benefits', 'NT: De Minimis', 'NT: SSS/PHIC/HDMF & Union Dues', 'NT: Salaries & Other Compensation',
    'Total Non-Taxable',
    'TX: Basic Salary', 'TX: Representation', 'TX: Transportation', 'TX: COLA', 'TX: Housing Allowance', 'TX: Other Regular',
    'TX: 13th Month & Other Benefits', 'TX: Hazard Pay', 'TX: Overtime Pay', 'TX: Other Supplementary',
    'Total Taxable (present)',
    'Previous Employer TIN', 'Previous Employer', 'Gross (previous)', 'Non-Taxable (previous)', 'Taxable (previous)',
    'Total Taxable (present + previous)', 'Tax Due',
    'Tax Withheld - Previous Employer', 'Tax Withheld Jan-Nov', 'Tax Withheld December', 'Over-withheld Refunded',
    'Tax Withheld as Adjusted (present)', 'PERA Tax Credit', 'Balance (due - withheld)',
  ]
  const body = rows
    .filter((r) => r.schedule === schedule)
    .map((r, i) => {
      const s = r.summary
      const e = r.employee
      return [
        i + 1, e.tin ?? '', e.last_name, e.first_name, e.middle_name ?? '', e.birth_date ?? '', e.nationality,
        e.address ?? '', e.zip_code ?? '', r.statusCode, r.from, r.to, r.separationCode, r.substitutedFiling ? 'Y' : 'N',
        ...(schedule === 2 ? [r.region, r.smwPerDay, r.smwPerMonth, r.smwPerYear, r.factor] : []),
        s.gross,
        s.mweBasic, s.mweHoliday, s.mweOvertime, s.mweNightDiff, s.mweHazard,
        s.thirteenthOtherBenefitsExempt, s.deMinimis, s.contributions, s.otherNonTaxable,
        s.totalNonTaxable,
        s.taxableBasic, s.taxableRepresentation, s.taxableTransportation, s.taxableCola, s.taxableHousing, s.taxableOtherRegular,
        s.taxable13thOtherBenefits, s.taxableHazard, s.taxableOvertime, s.taxableOtherSupplementary,
        s.totalTaxablePresent,
        r.prevEmployerTin, r.prevEmployerName, s.prevGross, s.prevNonTaxable, s.prevTaxable,
        s.totalTaxable, s.taxDue,
        s.prevTaxWithheld, s.withheldJanNov, s.withheldDec, s.refunded,
        s.withheldAsAdjusted, s.peraCredit, s.variance,
      ]
    })
  return [header, ...body]
}
