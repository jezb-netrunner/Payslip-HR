// BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld,
// January 2018 ENCS) figures for one employee and tax year, in the form's
// parts and order (spec T10): a minimum wage earner's exempt pay
// (statutory minimum wage, holiday, overtime, night shift differential and
// hazard pay) apart from taxable compensation, and the previous employer's
// data. Issued by January 31, or at final pay for an employee who leaves
// (the period then ends on the last day). The form's item numbers are left
// out: they couldn't be checked against the BIR's own copy.

import type { Entity } from '../lib/db'
import { fmtTin } from '../lib/format'
import type { AlphalistRow } from './alphalist'
import { round2 } from './types'

export interface Form2316Line {
  label: string
  value: number | string
  /** A total of the lines above it. */
  total?: boolean
}

export interface Form2316Part {
  title: string
  lines: Form2316Line[]
}

// Basis: RR 2-98 §2.78.1(B)(13) and §2.83.1, as amended by RR 11-2018 §§6, 12 (the 2316 at year end or at final pay, an MWE's exempt pay apart).
export function form2316Parts(row: AlphalistRow, entity: Entity, year: number): Form2316Part[] {
  const s = row.summary
  const e = row.employee
  const mwe = row.schedule === 2
  const name = `${e.last_name}${e.suffix ? ` ${e.suffix}` : ''}, ${e.first_name}${e.middle_name ? ` ${e.middle_name}` : ''}`
  return [
    {
      title: 'Part I — Employee information',
      lines: [
        { label: 'For the year', value: String(year) },
        { label: 'For the period', value: `${row.from} to ${row.to}` },
        { label: 'TIN', value: e.tin ?? '' },
        { label: "Employee's name", value: name },
        { label: 'Registered address', value: e.address ?? '' },
        { label: 'ZIP code', value: e.zip_code ?? '' },
        { label: 'Date of birth', value: e.birth_date ?? '' },
        { label: 'Statutory minimum wage per day', value: mwe ? row.smwPerDay : '' },
        { label: 'Statutory minimum wage per month', value: mwe ? row.smwPerMonth : '' },
        { label: 'Minimum wage earner (MWE) whose compensation is exempt from withholding tax and not subject to income tax', value: mwe ? 'Yes' : 'No' },
      ],
    },
    {
      title: 'Part II — Present employer',
      lines: [
        { label: 'TIN', value: fmtTin(entity.tin, entity.tin_branch_code) },
        { label: "Employer's name", value: entity.name },
        { label: 'Registered address', value: entity.registered_address },
        { label: 'ZIP code', value: entity.zip_code },
      ],
    },
    {
      title: 'Part III — Previous employer',
      lines: row.hasPreviousEmployer
        ? [
            { label: 'TIN', value: row.prevEmployerTin },
            { label: "Employer's name", value: row.prevEmployerName },
            { label: 'Registered address', value: row.prevEmployerAddress },
            { label: 'ZIP code', value: row.prevEmployerZip },
          ]
        : [{ label: 'Previous employer', value: 'None this year' }],
    },
    {
      title: 'Part IV-A — Summary',
      lines: [
        { label: 'Gross compensation income from present employer', value: s.gross },
        { label: 'Less: total non-taxable / exempt compensation income from present employer', value: s.totalNonTaxable },
        { label: 'Taxable compensation income from present employer', value: s.totalTaxablePresent },
        { label: 'Add: taxable compensation income from previous employer', value: s.prevTaxable },
        { label: 'Gross taxable compensation income', value: s.totalTaxable },
        { label: 'Tax due', value: s.taxDue },
        { label: 'Taxes withheld — present employer', value: s.withheldAsAdjusted },
        // the shortfall the year-end pay couldn't cover: the employer paid it for the employee (spec T8)
        ...(s.paidByEmployer > 0 ? [{ label: 'Of which paid by the employer at the year-end adjustment (an advance to the employee)', value: s.paidByEmployer }] : []),
        { label: 'Taxes withheld — previous employer', value: s.prevTaxWithheld },
        { label: 'Total amount of taxes withheld as adjusted', value: round2(s.withheldAsAdjusted + s.prevTaxWithheld), total: true },
        { label: '5% tax credit (PERA Act of 2008)', value: s.peraCredit },
        { label: 'Total taxes withheld', value: round2(s.withheldAsAdjusted + s.prevTaxWithheld + s.peraCredit), total: true },
      ],
    },
    {
      title: 'Part IV-B A — Non-taxable / exempt compensation (present employer)',
      lines: [
        { label: 'Basic salary or statutory minimum wage (MWE)', value: s.mweBasic },
        { label: 'Holiday pay (MWE)', value: s.mweHoliday },
        { label: 'Overtime pay (MWE)', value: s.mweOvertime },
        { label: 'Night shift differential (MWE)', value: s.mweNightDiff },
        { label: 'Hazard pay (MWE)', value: s.mweHazard },
        { label: '13th month pay and other benefits (up to ₱90,000)', value: s.thirteenthOtherBenefitsExempt },
        { label: 'De minimis benefits', value: s.deMinimis },
        { label: 'SSS, GSIS, PHIC and Pag-IBIG contributions and union dues (employee share only)', value: s.contributions },
        { label: 'Salaries and other forms of compensation', value: s.otherNonTaxable },
        { label: 'Total non-taxable / exempt compensation income', value: s.totalNonTaxable, total: true },
      ],
    },
    {
      title: 'Part IV-B B (regular) — Taxable compensation (present employer)',
      lines: [
        { label: 'Basic salary', value: s.taxableBasic },
        { label: 'Representation', value: s.taxableRepresentation },
        { label: 'Transportation', value: s.taxableTransportation },
        { label: 'Cost of living allowance (COLA)', value: s.taxableCola },
        { label: 'Fixed housing allowance', value: s.taxableHousing },
        { label: 'Others (regular)', value: s.taxableOtherRegular },
      ],
    },
    {
      title: 'Part IV-B B (supplementary) — Taxable compensation (present employer)',
      lines: [
        { label: 'Taxable 13th month pay and other benefits', value: s.taxable13thOtherBenefits },
        { label: 'Hazard pay', value: s.taxableHazard },
        { label: 'Overtime pay', value: s.taxableOvertime },
        { label: "Others (supplementary): holiday and premium pay, night differential, commission, an MWE's premium above the minimum wage", value: s.taxableOtherSupplementary },
        { label: 'Total taxable compensation income (present employer)', value: s.totalTaxablePresent, total: true },
      ],
    },
  ]
}
