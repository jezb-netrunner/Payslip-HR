// Spec T1 (payroll tax rules spec, 2026-10-25): the app's tax tables and
// ceilings against the spec's tables, one test per row. The spec's figures
// are typed in here independently of defaults.ts, so a wrong constant there
// fails a test instead of agreeing with itself.
import { describe, expect, it } from 'vitest'
import { BIR_ANNUAL_2023, BIR_WHT_2023, DE_MINIMIS_2026, DE_MINIMIS_2026_EFFECTIVE, DEFAULT_TABLES } from './defaults'
import { bracketFor, computeWithholdingTax, taxFromBrackets, type WhtPeriod } from './statutory'
import type { DeMinimisItem, StatutoryVersionRow, TaxBracket } from './types'
import { pickStatutoryTables } from './versions'

/** Tests allow a difference of 0.01 (spec §0 step 10). */
function expectPeso(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01 + 1e-9)
}

// [lower bound, base, rate] — Annex E, "Effective January 1, 2023 and onwards"
const ANNEX_E: Record<WhtPeriod, [number, number, number][]> = {
  daily: [
    [0, 0, 0],
    [685, 0, 0.15],
    [1096, 61.65, 0.2],
    [2192, 280.85, 0.25],
    [5479, 1102.6, 0.3],
    [21918, 6034.3, 0.35],
  ],
  weekly: [
    [0, 0, 0],
    [4808, 0, 0.15],
    [7692, 432.6, 0.2],
    [15385, 1971.2, 0.25],
    [38462, 7740.45, 0.3],
    [153846, 42355.65, 0.35],
  ],
  semi_monthly: [
    [0, 0, 0],
    [10417, 0, 0.15],
    [16667, 937.5, 0.2],
    [33333, 4270.7, 0.25],
    [83333, 16770.7, 0.3],
    [333333, 91770.7, 0.35],
  ],
  monthly: [
    [0, 0, 0],
    [20833, 0, 0.15],
    [33333, 1875, 0.2],
    [66667, 8541.8, 0.25],
    [166667, 33541.8, 0.3],
    [666667, 183541.8, 0.35],
  ],
}

// [over, base, rate on the excess] — annual table for the YEA, 2023 and later
const ANNUAL: [number, number, number][] = [
  [0, 0, 0],
  [250000, 0, 0.15],
  [400000, 22500, 0.2],
  [800000, 102500, 0.25],
  [2000000, 402500, 0.3],
  [8000000, 2202500, 0.35],
]

const PERIODS: WhtPeriod[] = ['daily', 'weekly', 'semi_monthly', 'monthly']

const annexRows = PERIODS.flatMap((period) =>
  ANNEX_E[period].map(([lower, base, rate], i) => ({ period, row: i + 1, lower, base, rate })),
)

/** An amount inside the row: 1,000 above its lower bound, or halfway to the next row when that is closer. */
function inside(rows: [number, number, number][], i: number): number {
  const next = rows[i + 1]?.[0]
  return next === undefined ? rows[i][0] + 1000 : rows[i][0] + Math.min(1000, (next - rows[i][0]) / 2)
}

describe('T1 Annex E withholding tax table (pay dated 2023-01-01 and later)', () => {
  it.each(annexRows)('$period row $row (lower bound $lower): constant, row pick and tax', ({ period, row, lower, base, rate }) => {
    const table = BIR_WHT_2023[period]
    const i = row - 1
    // the app's constant is the spec's row
    expect(table[i]).toEqual({ over: lower, base, rate })
    // the row with the highest lower bound <= the amount
    expect(bracketFor(lower, table)).toEqual(table[i])
    // tax = base + rate × (amount − lower bound)
    expectPeso(computeWithholdingTax(lower, period, BIR_WHT_2023), base)
    const amount = inside(ANNEX_E[period], i)
    expect(bracketFor(amount, table)).toEqual(table[i])
    expectPeso(computeWithholdingTax(amount, period, BIR_WHT_2023), base + rate * (amount - lower))
  })

  it.each(PERIODS)('%s table has exactly the spec rows', (period) => {
    expect(BIR_WHT_2023[period]).toHaveLength(ANNEX_E[period].length)
  })

  it('uses 6,034.30 for the top daily base (the BIR PDF prints "6,034.00.30")', () => {
    expect(BIR_WHT_2023.daily[5].base).toBe(6034.3)
    expectPeso(1102.6 + 0.3 * (21918 - 5479), 6034.3)
  })

  it.each(PERIODS)('%s table: every base = previous base + previous rate × lower-bound difference', (period) => {
    expectContinuous(BIR_WHT_2023[period])
  })

  it('rounds the tax to the centavo at the end, half up', () => {
    // 15% of ₱0.10 is ₱0.015
    expect(computeWithholdingTax(20833.1, 'monthly', BIR_WHT_2023)).toBe(0.02)
    expect(computeWithholdingTax(20833.06, 'monthly', BIR_WHT_2023)).toBe(0.01)
    expect(computeWithholdingTax(-50, 'monthly', BIR_WHT_2023)).toBe(0)
  })
})

describe('T1 annual tax table for the YEA (taxable year 2023 and later)', () => {
  it.each(ANNUAL.map(([over, base, rate], i) => ({ row: i + 1, over, base, rate })))(
    'row $row (over $over): constant and tax',
    ({ row, over, base, rate }) => {
      const brackets = BIR_ANNUAL_2023.brackets
      expect(brackets[row - 1]).toEqual({ over, base, rate })
      expect(bracketFor(over, brackets)).toEqual(brackets[row - 1])
      expectPeso(taxFromBrackets(over, brackets), base)
      expectPeso(taxFromBrackets(over + 10000, brackets), base + rate * 10000)
    },
  )

  it('has exactly the spec rows and is continuous', () => {
    expect(BIR_ANNUAL_2023.brackets).toHaveLength(ANNUAL.length)
    expectContinuous(BIR_ANNUAL_2023.brackets)
  })

  it('the ₱90,000 ceiling for 13th-month pay and other benefits', () => {
    expect(BIR_ANNUAL_2023.other_benefits_exemption_cap).toBe(90000)
    expect(DEFAULT_TABLES.bir_annual.other_benefits_exemption_cap).toBe(90000)
  })
})

function expectContinuous(rows: TaxBracket[]) {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    expectPeso(rows[i].base, prev.base + prev.rate * (rows[i].over - prev.over))
  }
}

// [item, unit, ceiling, per-month equivalent] — de minimis ceilings for pay dated 2026-01-07 and later
const DE_MINIMIS: { item: DeMinimisItem; unit: string; limit: number; per_month?: number }[] = [
  { item: 'a', unit: 'days_per_year', limit: 12 },
  { item: 'c', unit: 'per_semester', limit: 2000, per_month: 333 },
  { item: 'd', unit: 'per_month', limit: 2500 },
  { item: 'e', unit: 'per_year', limit: 8000 },
  { item: 'f', unit: 'per_year', limit: 12000 },
  { item: 'g', unit: 'per_month', limit: 400 },
  { item: 'h', unit: 'per_year', limit: 12000 },
  { item: 'i', unit: 'per_year', limit: 6000 },
  { item: 'j', unit: 'share_of_regional_minimum_wage', limit: 0.3 },
  { item: 'k', unit: 'per_year', limit: 12000 },
]

describe('T1 de minimis ceilings (RR 29-2025, pay dated 2026-01-07 and later)', () => {
  it.each(DE_MINIMIS)('item ($item): $limit $unit', ({ item, unit, limit, per_month }) => {
    const found = DE_MINIMIS_2026.items.find((c) => c.item === item)
    expect(found).toBeDefined()
    expect(found!.unit).toBe(unit)
    expect(found!.limit).toBe(limit)
    expect(found!.per_month).toBe(per_month)
  })

  it('has items a and c–k only (b is for government employees)', () => {
    expect(DE_MINIMIS_2026.items.map((c) => c.item).sort()).toEqual(['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'])
  })

  it('takes effect on 2026-01-07, the day after the 15th day from the 2025-12-22 posting', () => {
    expect(DE_MINIMIS_2026_EFFECTIVE).toBe('2026-01-07')
  })
})

describe('T1 table versions are picked by date', () => {
  const rows: StatutoryVersionRow[] = [
    { kind: 'sss', effective_from: '2025-01-01', data: DEFAULT_TABLES.sss },
    { kind: 'philhealth', effective_from: '2024-01-01', data: DEFAULT_TABLES.philhealth },
    { kind: 'pagibig', effective_from: '2024-02-01', data: DEFAULT_TABLES.pagibig },
    { kind: 'bir_wht', effective_from: '2023-01-01', data: DEFAULT_TABLES.bir_wht },
    { kind: 'bir_annual', effective_from: '2023-01-01', data: DEFAULT_TABLES.bir_annual },
    { kind: 'de_minimis', effective_from: DE_MINIMIS_2026_EFFECTIVE, data: DE_MINIMIS_2026 },
  ]

  it('pay dated 2026-01-06 has no de minimis ceilings on file (the spec does not give the earlier ones)', () => {
    expect(pickStatutoryTables(rows, '2026-01-06').de_minimis).toBeUndefined()
  })

  it('pay dated 2026-01-07 uses the RR 29-2025 ceilings', () => {
    const t = pickStatutoryTables(rows, '2026-01-07')
    expect(t.de_minimis).toEqual(DE_MINIMIS_2026)
    expect(t.bir_wht).toEqual(BIR_WHT_2023)
  })

  it('picks the newest version in force for each kind', () => {
    const later = { ...DEFAULT_TABLES.bir_annual, other_benefits_exemption_cap: 100000 }
    const withLater = [...rows, { kind: 'bir_annual' as const, effective_from: '2027-01-01', data: later }]
    expect(pickStatutoryTables(withLater, '2026-12-31').bir_annual.other_benefits_exemption_cap).toBe(90000)
    expect(pickStatutoryTables(withLater, '2027-01-01').bir_annual.other_benefits_exemption_cap).toBe(100000)
  })

  it('still refuses to compute when a required table is missing', () => {
    expect(() => pickStatutoryTables(rows.filter((r) => r.kind !== 'pagibig'), '2026-06-01')).toThrow(/incomplete/)
  })
})
