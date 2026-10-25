// Spec T2 (and §2): every pay line is classified by its pay code, and the
// taxable part is regular (R) or supplementary (S) compensation. The pay
// codes replace the old category list (owner's decision, 2026-10-25); every
// existing category maps to a code with the same BIR bucket and tax rule.
import { describe, expect, it } from 'vitest'
import {
  lineIncomeClass,
  PAY_CODES,
  payCodeForAllowanceCategory,
  payCodeForEarningCategory,
  payCodeOf,
} from './payCodes'
import type { AllowanceCategory, BirBucket } from './types'

const ALLOWANCE_CATEGORIES: AllowanceCategory[] = [
  'de_minimis', 'other_benefits', 'hazard', 'representation', 'transportation', 'cola', 'housing',
  'other_taxable', 'other_non_taxable',
]
const ONE_TIME_CATEGORIES: BirBucket[] = [
  'basic', 'holiday', 'overtime', 'night_diff', 'hazard', 'other_benefits', 'de_minimis', 'representation',
  'transportation', 'cola', 'housing', 'other_taxable', 'other_non_taxable',
]
// today's tax rule per bucket (isTaxableBucket): exempt for MWEs, the ₱90k bucket, de minimis, never taxable
const MWE_EXEMPT: BirBucket[] = ['basic', 'holiday', 'overtime', 'night_diff', 'hazard', 'cola']

describe('T2 pay codes', () => {
  it('codes are unique and written in capitals', () => {
    const codes = PAY_CODES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/)
  })

  it.each(ALLOWANCE_CATEGORIES)('allowance category %s maps to an allowance code with the same BIR bucket', (cat) => {
    const code = payCodeOf(payCodeForAllowanceCategory(cat))
    expect(code.for_allowances).toBe(true)
    expect(code.bir_bucket).toBe(cat)
  })

  it.each(ONE_TIME_CATEGORIES)('one-time category %s maps to a one-time code with the same BIR bucket', (cat) => {
    const code = payCodeOf(payCodeForEarningCategory(cat))
    expect(code.for_one_time).toBe(true)
    expect(code.bir_bucket).toBe(cat)
  })

  it('maternity pay maps to MAT_SSS_BENEFIT and MAT_DIFFERENTIAL', () => {
    expect(payCodeForEarningCategory('other_non_taxable', 'sss_maternity')).toBe('MAT_SSS_BENEFIT')
    expect(payCodeForEarningCategory('other_non_taxable', 'maternity_differential')).toBe('MAT_DIFFERENTIAL')
    expect(payCodeOf('MAT_SSS_BENEFIT').benefit).toBe('sss_maternity')
    expect(payCodeOf('MAT_DIFFERENTIAL').benefit).toBe('maternity_differential')
  })

  it('existing "other benefits" lines become the general bonus code (owner, 2026-10-25)', () => {
    expect(payCodeForAllowanceCategory('other_benefits')).toBe('BONUS')
    expect(payCodeForEarningCategory('other_benefits')).toBe('BONUS')
  })

  it('keeps today\'s tax rule for every code', () => {
    for (const c of PAY_CODES) {
      const expected = MWE_EXEMPT.includes(c.bir_bucket)
        ? 'mwe_exempt'
        : c.bir_bucket === 'other_benefits' || c.bir_bucket === 'thirteenth'
          ? 'benefits'
          : c.bir_bucket === 'de_minimis'
            ? 'de_minimis'
            : c.bir_bucket === 'other_non_taxable'
              ? 'exempt'
              : 'taxable'
      expect(`${c.code}: ${c.tax_treatment}`).toBe(`${c.code}: ${expected}`)
    }
  })

  it('R: basic pay and fixed allowances paid each period', () => {
    for (const code of ['REPRESENTATION', 'TRANSPORTATION', 'COLA', 'HOUSING', 'FIXED_ALLOWANCE']) {
      expect(lineIncomeClass(payCodeOf(code), 'allowance')).toBe('regular')
    }
    expect(lineIncomeClass(payCodeOf('BASIC_ADJ'), 'one_time')).toBe('regular')
  })

  it('S: overtime, premiums, night differential, hazard pay, commission, bonuses and other one-time pay', () => {
    for (const code of ['HOLIDAY_ADJ', 'OVERTIME_ADJ', 'NIGHT_DIFF_ADJ', 'HAZARD', 'COMMISSION', 'OTHER_TAXABLE', 'BONUS']) {
      expect(lineIncomeClass(payCodeOf(code), 'one_time')).toBe('supplementary')
    }
    expect(lineIncomeClass(payCodeOf('HAZARD'), 'allowance')).toBe('supplementary')
  })

  it('a fixed allowance paid once is supplementary (R is pay "paid each period")', () => {
    expect(lineIncomeClass(payCodeOf('REPRESENTATION'), 'one_time')).toBe('supplementary')
    expect(lineIncomeClass(payCodeOf('TRANSPORTATION'), 'one_time')).toBe('supplementary')
  })

  it('a code is only offered where it applies', () => {
    expect(payCodeOf('FIXED_ALLOWANCE').for_one_time).toBe(false)
    expect(payCodeOf('COMMISSION').for_allowances).toBe(false)
    expect(payCodeOf('BASIC_ADJ').for_allowances).toBe(false)
    expect(payCodeOf('MAT_DIFFERENTIAL').for_allowances).toBe(false)
  })

  it('an unknown code is an error, not a silent default', () => {
    expect(() => payCodeOf('NOPE')).toThrow(/Unknown pay code/)
  })
})
