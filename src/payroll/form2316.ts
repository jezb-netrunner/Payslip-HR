// BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld,
// September 2021 ENCS, RMC 34-2022) figures for one employee and tax year,
// item by item (spec T10, owner's answers 2026-10-25): a minimum wage
// earner's exempt pay (items 29–33) apart from taxable compensation, the
// previous employer's data (Part III), and taxable pay for the year within
// the 0% row reported as non-taxable (items 29 and 37, lowIncomeReport).
// Issued by January 31, or at final pay for an employee who leaves (the
// period then ends on the last day).

import type { Entity } from '../lib/db'
import { fmtTin } from '../lib/format'
import type { AlphalistRow } from './alphalist'
import { round2 } from './types'

export interface Form2316Line {
  /** The form's item number ("6A", "25B", "44A"…). */
  item: string
  label: string
  value: number | string
  /** A total of other items. */
  total?: boolean
  /** A signature box: signed on the printed form. */
  signature?: boolean
  /** A remark printed under the item. */
  note?: string
}

export interface Form2316Part {
  title: string
  lines: Form2316Line[]
}

const peso = (v: number) => `₱${v.toLocaleString('en-US')}`

// Basis: RR 2-98 §2.78.1(B)(13) and §2.83.1, as amended by RR 11-2018 §§6, 12 (the 2316 at year end or at final pay, an MWE's exempt pay apart). BIR Form 2316 September 2021 (ENCS), RMC 34-2022 (Mar 30, 2022).
export function form2316Parts(row: AlphalistRow, entity: Entity, year: number): Form2316Part[] {
  const s = row.summary
  const e = row.employee
  const mwe = row.schedule === 2
  const name = `${e.last_name}${e.suffix ? ` ${e.suffix}` : ''}, ${e.first_name}${e.middle_name ? ` ${e.middle_name}` : ''}`
  const prev = row.hasPreviousEmployer
  const item29 = round2(s.mweBasic + s.lowIncomeBasic)
  const item37 = round2(s.otherNonTaxable + s.lowIncomeOther)
  const item38 = s.totalNonTaxable
  const item52 = s.totalTaxablePresent
  const item26 = round2(s.withheldAsAdjusted + s.prevTaxWithheld)
  return [
    {
      title: 'Part I — Employee information',
      lines: [
        { item: '1', label: 'For the year', value: String(year) },
        { item: '2', label: 'For the period', value: `${row.from} to ${row.to}` },
        { item: '3', label: 'TIN', value: e.tin ?? '' },
        { item: '4', label: "Employee's name", value: name },
        { item: '5', label: 'RDO code', value: e.rdo_code ?? '' },
        { item: '6', label: 'Registered address', value: e.address ?? '' },
        { item: '6A', label: 'ZIP code', value: e.zip_code ?? '' },
        { item: '6B', label: 'Local home address', value: e.local_address ?? '' },
        { item: '6C', label: 'ZIP code', value: e.local_zip_code ?? '' },
        { item: '6D', label: 'Foreign address', value: e.foreign_address ?? '' },
        { item: '7', label: 'Date of birth', value: e.birth_date ?? '' },
        { item: '8', label: 'Contact number', value: e.phone ?? '' },
        { item: '9', label: 'Statutory minimum wage rate per day', value: mwe ? row.smwPerDay : '' },
        { item: '10', label: 'Statutory minimum wage rate per month', value: mwe ? row.smwPerMonth : '' },
        { item: '11', label: 'Minimum wage earner (MWE) whose compensation is exempt from withholding tax and not subject to income tax', value: mwe ? 'Yes' : 'No' },
      ],
    },
    {
      title: 'Part II — Present employer',
      lines: [
        { item: '12', label: 'TIN', value: fmtTin(entity.tin, entity.tin_branch_code) },
        { item: '13', label: "Employer's name", value: entity.name },
        { item: '14', label: 'Registered address', value: entity.registered_address },
        { item: '14A', label: 'ZIP code', value: entity.zip_code },
        { item: '15', label: 'Type of employer', value: row.employerType === 'secondary' ? 'Secondary employer' : 'Main employer' },
      ],
    },
    {
      title: 'Part III — Previous employer',
      lines: [
        { item: '16', label: 'TIN', value: prev ? row.prevEmployerTin : '' },
        { item: '17', label: "Employer's name", value: prev ? row.prevEmployerName : '' },
        { item: '18', label: 'Registered address', value: prev ? row.prevEmployerAddress : '' },
        { item: '18A', label: 'ZIP code', value: prev ? row.prevEmployerZip : '' },
      ],
    },
    {
      title: 'Part IV-A — Summary',
      lines: [
        { item: '19', label: 'Gross compensation income from present employer (items 38 + 52)', value: round2(item38 + item52), total: true },
        { item: '20', label: 'Less: total non-taxable / exempt compensation income from present employer (from item 38)', value: item38 },
        { item: '21', label: 'Taxable compensation income from present employer (from item 52)', value: item52 },
        { item: '22', label: 'Add: taxable compensation income from previous employer, if applicable', value: s.prevTaxable },
        { item: '23', label: 'Gross taxable compensation income (items 21 + 22)', value: round2(item52 + s.prevTaxable), total: true },
        { item: '24', label: 'Tax due', value: s.taxDue },
        {
          item: '25A',
          label: 'Amount of taxes withheld — present employer',
          value: s.withheldAsAdjusted,
          // the shortfall the year-end pay couldn't cover: the employer paid it for the employee (spec T8)
          ...(s.paidByEmployer > 0 ? { note: `Of which ${peso(s.paidByEmployer)} paid by the employer at the year-end adjustment (an advance to the employee).` } : {}),
        },
        { item: '25B', label: 'Amount of taxes withheld — previous employer, if applicable', value: s.prevTaxWithheld },
        { item: '26', label: 'Total amount of taxes withheld as adjusted (items 25A + 25B)', value: item26, total: true },
        { item: '27', label: '5% tax credit (PERA Act of 2008)', value: s.peraCredit },
        { item: '28', label: 'Total taxes withheld (items 26 + 27)', value: round2(item26 + s.peraCredit), total: true },
      ],
    },
    {
      title: 'Part IV-B A — Non-taxable / exempt compensation income (present employer)',
      lines: [
        {
          item: '29',
          label: `Basic salary (including the exempt ${peso(row.zeroRowCeiling)} & below) or the statutory minimum wage of the MWE`,
          value: item29,
          ...(s.lowIncome ? { note: `Taxable pay for the year is ${peso(row.zeroRowCeiling)} or less: the basic salary is here and the rest of the pay in item 37.` } : {}),
        },
        { item: '30', label: 'Holiday pay (MWE)', value: s.mweHoliday },
        { item: '31', label: 'Overtime pay (MWE)', value: s.mweOvertime },
        { item: '32', label: 'Night shift differential (MWE)', value: s.mweNightDiff },
        { item: '33', label: 'Hazard pay (MWE)', value: s.mweHazard },
        { item: '34', label: `13th month pay and other benefits (maximum of ${peso(row.benefitsCap)})`, value: s.thirteenthOtherBenefitsExempt },
        { item: '35', label: 'De minimis benefits', value: s.deMinimis },
        { item: '36', label: 'SSS, GSIS, PHIC and Pag-IBIG contributions and union dues (employee share only)', value: s.contributions },
        { item: '37', label: 'Salaries and other forms of compensation', value: item37 },
        { item: '38', label: 'Total non-taxable / exempt compensation income (items 29 to 37)', value: item38, total: true },
      ],
    },
    {
      title: 'Part IV-B B — Taxable compensation income, regular (present employer)',
      lines: [
        { item: '39', label: 'Basic salary', value: s.taxableBasic },
        { item: '40', label: 'Representation', value: s.taxableRepresentation },
        { item: '41', label: 'Transportation', value: s.taxableTransportation },
        { item: '42', label: 'Cost of living allowance (COLA)', value: s.taxableCola },
        { item: '43', label: 'Fixed housing allowance', value: s.taxableHousing },
        { item: '44A', label: 'Others (regular)', value: s.taxableOtherRegular },
        { item: '44B', label: 'Others (regular)', value: 0 },
      ],
    },
    {
      title: 'Part IV-B B — Taxable compensation income, supplementary (present employer)',
      lines: [
        { item: '45', label: 'Commission', value: s.taxableCommission },
        { item: '46', label: 'Profit sharing', value: 0 },
        { item: '47', label: "Fees including director's fees", value: 0 },
        { item: '48', label: 'Taxable 13th month benefits', value: s.taxable13thOtherBenefits },
        { item: '49', label: 'Hazard pay', value: s.taxableHazard },
        { item: '50', label: 'Overtime pay', value: s.taxableOvertime },
        { item: '51A', label: "Others (supplementary): holiday and premium pay, night differential, an MWE's premium above the minimum wage", value: s.taxableOtherSupplementary },
        { item: '51B', label: 'Others (supplementary)', value: 0 },
        { item: '52', label: 'Total taxable compensation income (items 39 to 51B)', value: item52, total: true },
      ],
    },
    {
      title: 'Signatures',
      lines: [
        { item: '53', label: 'Present employer or authorized agent: signature over printed name, and date signed', value: '', signature: true },
        { item: '54', label: 'Employee: signature over printed name, and date signed', value: '', signature: true },
        { item: '55', label: 'Substituted filing — present employer or authorized agent: signature over printed name, and date signed', value: '', signature: true },
        { item: '56', label: 'Substituted filing — employee: signature over printed name, and date signed', value: '', signature: true },
      ],
    },
  ]
}
