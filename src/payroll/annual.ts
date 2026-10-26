// Year-level BIR computation shared by payroll annualization (last payroll
// of the year / separation) and the 1604-C alphalist: classifies a year's
// finalized payslips into the BIR Form 2316 columns and computes the tax due
// on the annual graduated table.
//
// Conventions (kept identical to the per-period engine):
//  - For minimum wage earners the statutory minimum wage package — basic,
//    holiday/premium, overtime, night differential, hazard pay (and COLA
//    fixed by the wage order) — is exempt (NIRC Sec. 24(A)(2)); other
//    compensation stays taxable.
//  - Employee SSS/PhilHealth/Pag-IBIG shares and union dues are carved out
//    of basic pay (NIRC Sec. 32(B)(7)(f)), so gross = non-taxable + taxable.
//  - 13th month pay and other benefits share one exemption cap per year
//    across all employers (Sec. 32(B)(7)(e)); only the excess is taxable.

import { taxFromBrackets } from './statutory'
import { round2, type BirAnnualData, type BirBucket } from './types'

export interface AnnualPayslipFact {
  /** Month the pay was released (YYYY-MM-01): withholding tax is reported
   *  when compensation is paid, so this — not the payroll month — decides
   *  the tax year and the December / January–November split. */
  payMonth: string
  isMwe: boolean
  earnings: { amount: number; bir?: BirBucket; taxable?: boolean }[]
  /** SSS (incl. MPF) + PhilHealth + Pag-IBIG employee shares. */
  contributionsEe: number
  unionDues: number
  /** Negative for a refund made through annualization. */
  withholdingTax: number
}

/** Figures from the previous employer's BIR Form 2316 (same calendar year). */
export interface PriorEmployerInput {
  mweExempt: number
  thirteenthOtherBenefitsExempt: number
  deMinimis: number
  contributions: number
  otherNonTaxable: number
  taxableBasic: number
  taxable13thOtherBenefits: number
  taxableOther: number
  taxWithheld: number
}

export const NO_PRIOR_EMPLOYER: PriorEmployerInput = {
  mweExempt: 0,
  thirteenthOtherBenefitsExempt: 0,
  deMinimis: 0,
  contributions: 0,
  otherNonTaxable: 0,
  taxableBasic: 0,
  taxable13thOtherBenefits: 0,
  taxableOther: 0,
  taxWithheld: 0,
}

export interface AnnualSummary {
  /** Gross compensation from the present employer. */
  gross: number
  // ---- non-taxable / exempt (present employer) ----
  mweBasic: number
  mweHoliday: number
  mweOvertime: number
  mweNightDiff: number
  mweHazard: number
  /** 13th month pay + other benefits paid (before the cap). */
  thirteenthOtherBenefits: number
  thirteenthOtherBenefitsExempt: number
  deMinimis: number
  /** Employee SSS/PhilHealth/Pag-IBIG shares + union dues. */
  contributions: number
  /** Salaries and other forms of compensation (non-taxable). */
  otherNonTaxable: number
  totalNonTaxable: number
  // ---- taxable (present employer) ----
  taxableBasic: number
  taxableRepresentation: number
  taxableTransportation: number
  taxableCola: number
  taxableHousing: number
  taxableOtherRegular: number
  taxable13thOtherBenefits: number
  taxableHazard: number
  taxableOvertime: number
  /** Holiday/premium pay and night differential of non-MWEs. */
  taxableOtherSupplementary: number
  /** An MWE's rest-day and special-day premiums (2316 item 51, "Premium pay (MWE)"). */
  taxablePremiumMwe: number
  totalTaxablePresent: number
  // ---- previous employer ----
  prevGross: number
  prevNonTaxable: number
  prevTaxable: number
  prevTaxWithheld: number
  // ---- tax ----
  totalTaxable: number
  taxDue: number
  withheldJanNov: number
  /** Positive December withholding, including a year-end annualization. */
  withheldDec: number
  /** Over-withheld tax refunded to the employee through annualization. */
  refunded: number
  /** Present employer's withholding as adjusted: Jan–Nov + December − refunds. */
  withheldAsAdjusted: number
  peraCredit: number
  /** Tax due − (previous employer + present as adjusted + PERA credit); 0 when fully adjusted. */
  variance: number
  /** Every payslip of the year was computed as a minimum wage earner. */
  allMwe: boolean
}

const MWE_EXEMPT_BUCKETS: BirBucket[] = ['basic', 'holiday', 'overtime', 'night_diff', 'hazard', 'cola']

/**
 * Whether an earnings line of this BIR bucket is taxable in its pay period.
 * 13th month pay and other benefits are treated as exempt per period; the
 * excess over the annual cap is taxed through annualization.
 */
export function isTaxableBucket(bucket: BirBucket, isMwe: boolean): boolean {
  switch (bucket) {
    case 'thirteenth':
    case 'other_benefits':
    case 'de_minimis':
    case 'other_non_taxable':
      return false
    case 'basic':
    case 'holiday':
    case 'overtime':
    case 'night_diff':
    case 'hazard':
    case 'cola':
      return !isMwe
    default:
      return true
  }
}

export function summarizeYear(
  facts: AnnualPayslipFact[],
  annual: BirAnnualData,
  prior: PriorEmployerInput = NO_PRIOR_EMPLOYER,
  peraCredit = 0,
): AnnualSummary {
  const b = {
    mweBasic: 0, mweHoliday: 0, mweOvertime: 0, mweNightDiff: 0, mweHazard: 0, mweCola: 0,
    nonBasic: 0, holiday: 0, overtime: 0, nightDiff: 0, hazard: 0, cola: 0,
    representation: 0, transportation: 0, housing: 0, otherTaxable: 0, premium: 0, premiumMwe: 0,
    thirteenthOb: 0, deMinimis: 0, otherNonTaxable: 0,
    contribMwe: 0, contribNon: 0,
  }
  let gross = 0
  let withheldJanNov = 0
  let withheldDec = 0
  let refunded = 0

  for (const f of facts) {
    for (const l of f.earnings) {
      gross += l.amount
      const bucket: BirBucket = l.bir ?? (l.taxable ? 'other_taxable' : 'other_non_taxable')
      // an MWE's pay in these buckets is exempt unless the line says
      // otherwise (hazard pay without the hazardous-assignment certification)
      if (f.isMwe && MWE_EXEMPT_BUCKETS.includes(bucket) && l.taxable !== true) {
        if (bucket === 'basic') b.mweBasic += l.amount
        else if (bucket === 'holiday') b.mweHoliday += l.amount
        else if (bucket === 'overtime') b.mweOvertime += l.amount
        else if (bucket === 'night_diff') b.mweNightDiff += l.amount
        else if (bucket === 'hazard') b.mweHazard += l.amount
        else b.mweCola += l.amount
        continue
      }
      switch (bucket) {
        case 'basic': b.nonBasic += l.amount; break
        case 'holiday': b.holiday += l.amount; break
        case 'overtime': b.overtime += l.amount; break
        case 'night_diff': b.nightDiff += l.amount; break
        case 'hazard': b.hazard += l.amount; break
        case 'cola': b.cola += l.amount; break
        case 'representation': b.representation += l.amount; break
        case 'transportation': b.transportation += l.amount; break
        case 'housing': b.housing += l.amount; break
        case 'premium':
          if (f.isMwe) b.premiumMwe += l.amount
          else b.premium += l.amount
          break
        case 'other_taxable': b.otherTaxable += l.amount; break
        case 'thirteenth':
        case 'other_benefits': b.thirteenthOb += l.amount; break
        case 'de_minimis': b.deMinimis += l.amount; break
        case 'other_non_taxable': b.otherNonTaxable += l.amount; break
        // an unrecognized bucket still has to land in some 2316 column, or
        // gross no longer equals non-taxable + taxable
        default:
          if (l.taxable === false) b.otherNonTaxable += l.amount
          else b.otherTaxable += l.amount
      }
    }
    const c = f.contributionsEe + f.unionDues
    if (f.isMwe) b.contribMwe += c
    else b.contribNon += c

    const wht = f.withholdingTax
    if (wht < 0) refunded += -wht
    else if (f.payMonth.slice(5, 7) === '12') withheldDec += wht
    else withheldJanNov += wht
  }

  // Contributions come out of basic pay first; any remainder (a year with
  // almost no basic) reduces other taxable compensation.
  const mweCarve = Math.min(b.contribMwe, Math.max(0, b.mweBasic))
  const nonCarve = Math.min(b.contribNon, Math.max(0, b.nonBasic))
  const spill = b.contribMwe - mweCarve + (b.contribNon - nonCarve)

  const remainingCap = Math.max(0, annual.other_benefits_exemption_cap - prior.thirteenthOtherBenefitsExempt)
  const exempt13 = Math.min(b.thirteenthOb, remainingCap)
  const taxable13 = b.thirteenthOb - exempt13

  const contributions = b.contribMwe + b.contribNon
  const mweBasic = b.mweBasic - mweCarve
  const otherNonTaxable = b.otherNonTaxable + b.mweCola
  const totalNonTaxable =
    mweBasic + b.mweHoliday + b.mweOvertime + b.mweNightDiff + b.mweHazard +
    exempt13 + b.deMinimis + contributions + otherNonTaxable

  const taxableBasic = b.nonBasic - nonCarve
  const taxableOtherRegular = b.otherTaxable - spill
  const taxableOtherSupplementary = b.holiday + b.nightDiff + b.premium
  const totalTaxablePresent =
    taxableBasic + b.representation + b.transportation + b.cola + b.housing +
    taxableOtherRegular + taxable13 + b.hazard + b.overtime + taxableOtherSupplementary + b.premiumMwe

  const prevNonTaxable =
    prior.mweExempt + prior.thirteenthOtherBenefitsExempt + prior.deMinimis +
    prior.contributions + prior.otherNonTaxable
  const prevTaxable = prior.taxableBasic + prior.taxable13thOtherBenefits + prior.taxableOther
  const totalTaxable = Math.max(0, totalTaxablePresent + prevTaxable)
  const taxDue = taxFromBrackets(round2(totalTaxable), annual.brackets)
  const withheldAsAdjusted = withheldJanNov + withheldDec - refunded

  return {
    gross: round2(gross),
    mweBasic: round2(mweBasic),
    mweHoliday: round2(b.mweHoliday),
    mweOvertime: round2(b.mweOvertime),
    mweNightDiff: round2(b.mweNightDiff),
    mweHazard: round2(b.mweHazard),
    thirteenthOtherBenefits: round2(b.thirteenthOb),
    thirteenthOtherBenefitsExempt: round2(exempt13),
    deMinimis: round2(b.deMinimis),
    contributions: round2(contributions),
    otherNonTaxable: round2(otherNonTaxable),
    totalNonTaxable: round2(totalNonTaxable),
    taxableBasic: round2(taxableBasic),
    taxableRepresentation: round2(b.representation),
    taxableTransportation: round2(b.transportation),
    taxableCola: round2(b.cola),
    taxableHousing: round2(b.housing),
    taxableOtherRegular: round2(taxableOtherRegular),
    taxable13thOtherBenefits: round2(taxable13),
    taxableHazard: round2(b.hazard),
    taxableOvertime: round2(b.overtime),
    taxableOtherSupplementary: round2(taxableOtherSupplementary),
    taxablePremiumMwe: round2(b.premiumMwe),
    totalTaxablePresent: round2(totalTaxablePresent),
    prevGross: round2(prevNonTaxable + prevTaxable),
    prevNonTaxable: round2(prevNonTaxable),
    prevTaxable: round2(prevTaxable),
    prevTaxWithheld: round2(prior.taxWithheld),
    totalTaxable: round2(totalTaxable),
    taxDue,
    withheldJanNov: round2(withheldJanNov),
    withheldDec: round2(withheldDec),
    refunded: round2(refunded),
    withheldAsAdjusted: round2(withheldAsAdjusted),
    peraCredit: round2(peraCredit),
    variance: round2(taxDue - prior.taxWithheld - withheldAsAdjusted - peraCredit),
    allMwe: facts.length > 0 && facts.every((f) => f.isMwe),
  }
}

/**
 * Withholding for an annualizing payroll (last payroll of the year, or the
 * final pay of a separated employee): annual tax due on everything paid so
 * far including this payroll, minus every peso already withheld (previous
 * employer, this employer's earlier payrolls) and the PERA tax credit.
 * Negative = refund of over-withheld tax.
 */
export function annualizedWithholding(
  ytd: AnnualPayslipFact[],
  current: AnnualPayslipFact,
  annual: BirAnnualData,
  prior: PriorEmployerInput = NO_PRIOR_EMPLOYER,
  peraCredit = 0,
): { withholding: number; summary: AnnualSummary } {
  const summary = summarizeYear([...ytd, { ...current, withholdingTax: 0 }], annual, prior, peraCredit)
  const alreadyWithheld = ytd.reduce((s, f) => s + f.withholdingTax, 0)
  return {
    withholding: round2(summary.taxDue - prior.taxWithheld - alreadyWithheld - peraCredit),
    summary,
  }
}
