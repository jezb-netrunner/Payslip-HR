// BIR Form 1604-C (January 2018 ENCS) alphalist rows in the revised format
// of RMC 160-2022 (with the PERA 5% tax credit; Schedule 1 = employees,
// Schedule 2 = minimum wage earners) built from a client's finalized
// payslips for a calendar year. The figures mirror BIR Form 2316 (September
// 2021 ENCS, item map below); the payroll officer keys or imports them into
// the BIR Alphalist Data Entry and Validation Module, which produces the DAT
// file. Basis: NIRC Sec. 83; RR 2-98 Sec. 2.83.1 as amended by RR 11-2018;
// RR 16-2021 Sec. 2; RMC 160-2022; RMC 29-2024.

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
  /** Previous employer's section: status code, employment period, reason-of-separation code. */
  prevStatusCode: string
  prevFrom: string
  prevTo: string
  prevSeparationCode: string
  prior: PriorEmployerInput
  /** Data to fix before filing. */
  issues: string[]
  /** Withheld vs due difference, settled by an annualizing run; normal while the year is in progress. */
  withholdingGap: string
  /** The 2316 of an employee separated in the year is issued on the last pay day (NIRC Sec. 83(A)); else ''. */
  issuedOn: string
}

/** The pay rate on an employee's last minimum-wage payslip of the year. */
export interface YearEndRate {
  payType: 'daily' | 'monthly'
  daily: number
  monthly: number
}

export function buildAlphalist(params: {
  year: number
  entity: Entity
  employees: Employee[]
  payslips: { employee_id: string; fact: AnnualPayslipFact }[]
  taxYears: EmployeeTaxYear[]
  annual: BirAnnualData
  /**
   * Schedule 2's statutory minimum wage: the rate actually paid at year end
   * (a raise after December must not change last year's alphalist).
   * Missing = the employee's current rate.
   */
  yearEndRates?: Map<string, YearEndRate>
}): AlphalistRow[] {
  const { year, entity, employees, payslips, taxYears, annual, yearEndRates } = params
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
    const rate = yearEndRates?.get(e.id) ?? { payType: e.pay_type, daily: Number(e.daily_rate), monthly: Number(e.monthly_rate) }
    const smwPerDay = rate.payType === 'daily' ? rate.daily : round2((rate.monthly * 12) / factor)

    const autoSubstituted =
      !ty?.has_previous_employer && !separated && summary.variance === 0
    const substitutedFiling =
      ty?.substituted_filing === 'yes' ? true : ty?.substituted_filing === 'no' ? false : autoSubstituted

    const issues: string[] = []
    if (!e.tin) issues.push('No TIN')
    if (!e.birth_date) issues.push('No birth date')
    if (!e.address || !e.zip_code) issues.push('No address/ZIP')
    if (summary.allMwe && !entity.minimum_wage_region) issues.push('Client wage region not set')
    if (ty?.has_previous_employer && !ty.prev_employer_tin) issues.push('Previous employer TIN missing')
    if (ty?.has_previous_employer && (!ty.prev_employment_from || !ty.prev_employment_to)) {
      issues.push('Previous employment period missing')
    }
    if (separatedBefore) {
      issues.push(`Separated ${e.separation_date}, paid in ${year}: check the employment dates the BIR module accepts`)
    }

    const lastPay = facts.reduce((m, f) => ((f.payDate ?? '') > m ? (f.payDate ?? '') : m), '')
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
      prevStatusCode: ty?.has_previous_employer && ty.prev_employment_status ? EMPLOYMENT_STATUS_BIR[ty.prev_employment_status] : '',
      prevFrom: ty?.has_previous_employer ? (ty.prev_employment_from ?? '') : '',
      prevTo: ty?.has_previous_employer ? (ty.prev_employment_to ?? '') : '',
      prevSeparationCode: ty?.has_previous_employer && ty.prev_separation_reason ? SEPARATION_REASON_BIR[ty.prev_separation_reason] : '',
      prior,
      issues,
      withholdingGap:
        summary.variance > 0
          ? `Under-withheld by ₱${summary.variance.toLocaleString()} — annualize`
          : summary.variance < 0
            ? `Over-withheld by ₱${(-summary.variance).toLocaleString()} — refund via annualization`
            : '',
      issuedOn: separated ? lastPay : '',
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
    'TX: Commission', 'TX: Profit Sharing', 'TX: Fees',
    'TX: 13th Month & Other Benefits', 'TX: Hazard Pay', 'TX: Overtime Pay', 'TX: Other Supplementary', 'TX: Premium Pay (MWE)',
    'Total Taxable (present)',
    'Previous Employer TIN', 'Previous Employer', 'Prev Employment Status', 'Prev Employed From', 'Prev Employed To',
    'Prev Reason of Separation',
    'Gross (previous)',
    'Prev NT: Basic SMW, Holiday, OT, ND, Hazard (MWE)', 'Prev NT: 13th Month & Other Benefits', 'Prev NT: De Minimis',
    'Prev NT: SSS/PHIC/HDMF & Union Dues', 'Prev NT: Salaries & Other Compensation', 'Non-Taxable (previous)',
    'Prev TX: Basic Salary', 'Prev TX: 13th Month & Other Benefits', 'Prev TX: Salaries & Other Compensation',
    'Taxable (previous)',
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
        s.taxableCommission, s.taxableProfitSharing, s.taxableFees,
        s.taxable13thOtherBenefits, s.taxableHazard, s.taxableOvertime, s.taxableOtherSupplementary, s.taxablePremiumMwe,
        s.totalTaxablePresent,
        r.prevEmployerTin, r.prevEmployerName, r.prevStatusCode, r.prevFrom, r.prevTo, r.prevSeparationCode,
        s.prevGross,
        r.prior.mweExempt, r.prior.thirteenthOtherBenefitsExempt, r.prior.deMinimis, r.prior.contributions,
        r.prior.otherNonTaxable, s.prevNonTaxable,
        r.prior.taxableBasic, r.prior.taxable13thOtherBenefits, r.prior.taxableOther, s.prevTaxable,
        s.totalTaxable, s.taxDue,
        s.prevTaxWithheld, s.withheldJanNov, s.withheldDec, s.refunded,
        s.withheldAsAdjusted, s.peraCredit, s.variance,
      ]
    })
  return [header, ...body]
}

/** BIR Form 2316 (September 2021 ENCS) items 29–52, Part IV-B. */
export type Form2316Item =
  | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38
  | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | '51A' | '51B' | 52

export const FORM_2316_LABELS: Record<Form2316Item, string> = {
  29: 'Basic salary (including the exempt ₱250,000 and below) or the statutory minimum wage of the MWE',
  30: 'Holiday pay (MWE)',
  31: 'Overtime pay (MWE)',
  32: 'Night shift differential (MWE)',
  33: 'Hazard pay (MWE)',
  34: '13th month pay and other benefits (maximum of ₱90,000)',
  35: 'De minimis benefits',
  36: 'SSS, GSIS, PHIC & Pag-IBIG contributions and union dues (employee share only)',
  37: 'Salaries and other forms of compensation',
  38: 'Total non-taxable / exempt compensation income (sum of items 29 to 37)',
  39: 'Basic salary',
  40: 'Representation',
  41: 'Transportation',
  42: 'Cost of living allowance (COLA)',
  43: 'Fixed housing allowance',
  44: 'Others (regular)',
  45: 'Commission',
  46: 'Profit sharing',
  47: 'Fees including directors’ fees',
  48: 'Taxable 13th month benefits and other benefits',
  49: 'Hazard pay',
  50: 'Overtime pay',
  '51A': 'Others: Premium pay (MWE)',
  '51B': 'Others (supplementary): holiday/premium pay, night shift differential, other',
  52: 'Total taxable compensation income (sum of items 39 to 51B)',
}

/** The year's figures by 2316 item. */
export function form2316Items(s: AnnualSummary): Record<Form2316Item, number> {
  const items: Record<Form2316Item, number> = {
    29: s.mweBasic, 30: s.mweHoliday, 31: s.mweOvertime, 32: s.mweNightDiff, 33: s.mweHazard,
    34: s.thirteenthOtherBenefitsExempt, 35: s.deMinimis, 36: s.contributions, 37: s.otherNonTaxable, 38: s.totalNonTaxable,
    39: s.taxableBasic, 40: s.taxableRepresentation, 41: s.taxableTransportation, 42: s.taxableCola, 43: s.taxableHousing,
    44: s.taxableOtherRegular, 45: s.taxableCommission, 46: s.taxableProfitSharing, 47: s.taxableFees,
    48: s.taxable13thOtherBenefits, 49: s.taxableHazard, 50: s.taxableOvertime,
    '51A': s.taxablePremiumMwe, '51B': s.taxableOtherSupplementary, 52: s.totalTaxablePresent,
  }
  return items
}

/**
 * RR 11-2018 Annex F: the employer's certified list of employees qualified
 * for substituted filing of their income tax return, submitted with the
 * BIR copies of the 2316s.
 */
export function annexFCsv(
  rows: Pick<AlphalistRow, 'substitutedFiling' | 'employee'>[],
  entity: Pick<Entity, 'name' | 'tin'>,
  year: number,
): (string | number)[][] {
  const qualified = rows.filter((r) => r.substitutedFiling)
  return [
    [`Certified List of Employees Qualified for Substituted Filing of ITR (BIR Form 1700) — taxable year ${year}`],
    [`Employer: ${entity.name}`, `TIN: ${entity.tin}`],
    [
      'This is to certify that the employees listed below received purely compensation income from this employer only during the year, their tax was correctly withheld, and they qualify for substituted filing (RR 2-98 Sec. 2.83.4 as amended by RR 11-2018).',
    ],
    [],
    ['Seq', 'TIN', 'Last Name', 'First Name', 'Middle Name'],
    ...qualified.map((r, i) => [i + 1, r.employee.tin ?? '', r.employee.last_name, r.employee.first_name, r.employee.middle_name ?? '']),
  ]
}
