// Spec T2: the regular method finds the table row from R only, and the
// cumulative average method (CAM) applies from a trigger to the end of the
// calendar year. Monthly table for the spec's vectors W1–W4.
import { describe, expect, it } from 'vitest'
import { BIR_WHT_2023 } from './defaults'
import { computeWithholdingTax } from './statutory'
import {
  camTotalDue,
  periodsBetween,
  periodWithholding,
  regularMethodTax,
  withholdingFactOf,
  type WithholdingYtdFact,
} from './withholding'

const monthly = BIR_WHT_2023.monthly
const semiMonthly = BIR_WHT_2023.semi_monthly

/** Tests allow a difference of 0.01 (spec §0 step 10). */
function expectPeso(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01 + 1e-9)
}

const monthEnd = (m: number) => `2026-${String(m).padStart(2, '0')}-28`

/** Runs January..`to` through periodWithholding, feeding each result into the year to date. */
function runMonths(R: (m: number) => number, S: (m: number) => number, to = 12) {
  const ytd: WithholdingYtdFact[] = []
  const out: { tax: number; method: string; trigger?: string }[] = []
  for (let m = 1; m <= to; m++) {
    const payDate = monthEnd(m)
    const r = periodWithholding({ regular: R(m), supplementary: S(m), payDate, frequency: 'monthly', brackets: monthly, ytd })
    out.push({ tax: r.tax, method: r.method, trigger: r.trigger })
    ytd.push({ payDate, regular: R(m), supplementary: S(m), withheld: r.tax, method: r.method, gross: R(m) + S(m) })
  }
  return out
}

describe('T2 regular method: the row comes from R only', () => {
  it('W1: R 60,000 and S 20,000 withhold 11,208.40 (the old method gave 11,875.05)', () => {
    expectPeso(regularMethodTax(60000, 20000, monthly), 11208.4)
    expectPeso(computeWithholdingTax(80000, 'monthly', BIR_WHT_2023), 11875.05)
    const r = periodWithholding({ regular: 60000, supplementary: 20000, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [] })
    expect(r.method).toBe('regular')
    expectPeso(r.tax, 11208.4)
  })

  it('a row boundary: R 33,332 stays in the 15% row even when R + S passes 33,333', () => {
    expectPeso(regularMethodTax(33332, 1000, monthly), 0.15 * (34332 - 20833))
    expectPeso(regularMethodTax(33333, 1000, monthly), 1875 + 0.2 * 1000)
  })

  it('with no supplementary pay it is the plain table', () => {
    expectPeso(regularMethodTax(25000, 0, monthly), computeWithholdingTax(25000, 'monthly', BIR_WHT_2023))
    expect(regularMethodTax(0, 0, monthly)).toBe(0)
  })
})

describe('T2 cumulative average method (CAM)', () => {
  it('W2 trigger (a): R 18,000 a month, S 10,000 overtime in March only', () => {
    const r = runMonths(() => 18000, (m) => (m === 3 ? 10000 : 0))
    expect(r.slice(0, 5).map((x) => x.tax)).toEqual([0, 0, 225.15, 0, 0])
    expect(r[2].trigger).toBe('a')
    // CAM stays active from March to December
    expect(r.map((x) => x.method)).toEqual(['regular', 'regular', ...Array(10).fill('cam')])
  })

  it('W3 trigger (b): S 30,000 ≥ R 25,000 starts CAM, which stays on when S is 0', () => {
    const r = runMonths(() => 25000, (m) => (m === 1 ? 30000 : 0), 4)
    expect(r.map((x) => x.method)).toEqual(['cam', 'cam', 'cam', 'cam'])
    expect(r[0].trigger).toBe('b')
    // January: one period, cum 55,000 → 1,875 + 20% × 21,667
    expectPeso(r[0].tax, 6208.4)
    // February: cum 80,000 over 2 periods → 2 × 1,875 + 20% × (80,000 − 2 × 33,333), less 6,208.40 withheld
    expectPeso(r[1].tax, 6416.8 - 6208.4)
    // the regular method would have taken 625.05 in February
    expectPeso(regularMethodTax(25000, 0, monthly), 625.05)
  })

  it('S equal to R is trigger (b) too', () => {
    const r = periodWithholding({ regular: 30000, supplementary: 30000, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [] })
    expect(r.method).toBe('cam')
    expect(r.trigger).toBe('b')
  })

  it('a period with no pay at all is not trigger (b): S must be more than 0 (our reading)', () => {
    const r = periodWithholding({ regular: 0, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [] })
    expect(r.method).toBe('regular')
    expect(r.tax).toBe(0)
  })

  it('W4 trigger (c): a new hire with a previous employer this year uses CAM from the first period', () => {
    // previous employer Jan–Apr: 4 × 30,000, withheld 4 × 1,375.05; joins in May at 30,000 a month
    const prior = { taxable: 120000, withheld: 5500.2, employedFrom: '2026-01-01', employedTo: '2026-04-30' }
    const r = periodWithholding({ regular: 30000, supplementary: 0, payDate: '2026-05-31', frequency: 'monthly', brackets: monthly, ytd: [], prior })
    expect(r.method).toBe('cam')
    expect(r.trigger).toBe('c')
    expect(r.n).toBe(5) // January (previous employer) to May
    expectPeso(r.cum!, 150000)
    // 0.15 × (150,000 − 5 × 20,833) = 6,875.25 due, less 5,500.20 withheld
    expectPeso(r.tax, 1375.05)
    // and it stays on
    const june = periodWithholding({
      regular: 30000, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly,
      ytd: [{ payDate: '2026-05-31', regular: 30000, supplementary: 0, withheld: r.tax, method: 'cam', gross: 30000 }], prior,
    })
    expect(june.method).toBe('cam')
    expect(june.n).toBe(6)
  })

  it('a trigger in an earlier period keeps CAM on, also when that period was paid before this change', () => {
    // no stored method (paid under the old rules), but S ≥ R in February
    const ytd: WithholdingYtdFact[] = [
      { payDate: '2026-01-31', regular: 25000, supplementary: 0, withheld: 625.05, gross: 25000 },
      { payDate: '2026-02-28', regular: 25000, supplementary: 30000, withheld: 8000, gross: 55000 },
    ]
    const r = periodWithholding({ regular: 25000, supplementary: 0, payDate: '2026-03-31', frequency: 'monthly', brackets: monthly, ytd })
    expect(r.method).toBe('cam')
    expect(r.trigger).toBe('earlier')
  })

  it('counts n from the first period of the year with compensation, gaps included', () => {
    const ytd: WithholdingYtdFact[] = [{ payDate: '2026-02-28', regular: 18000, supplementary: 5000, withheld: 0, gross: 23000 }]
    // first compensation in February; June is the 5th monthly period
    const r = periodWithholding({ regular: 18000, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd })
    expect(r.n).toBe(5)
  })

  // owner 2026-10-25 (reading 4 changed): n counts only the periods with
  // employment — the previous employer's from–to and this employer's
  // periods — not the gap between jobs (RR 2-98 §2.79(B)(5)(a) Step 2)
  it('n skips the gap between jobs: previous employer January–February, this employer from June', () => {
    const prior = { taxable: 60000, withheld: 2750.1, employedFrom: '2026-01-01', employedTo: '2026-02-28' }
    const r = periodWithholding({ regular: 30000, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [], prior })
    expect(r.n).toBe(3) // January, February, June
    expect(r.from).toBe('2026-01-01')
    // 0.15 × (90,000 − 3 × 20,833) = 4,125.15 due, less 2,750.10 withheld
    expectPeso(r.tax, 1375.05)
  })

  it('a period both jobs fall in counts once', () => {
    const prior = { taxable: 100000, withheld: 0, employedFrom: '2026-01-01', employedTo: '2026-04-10' }
    const ytd: WithholdingYtdFact[] = [{ payDate: '2026-04-30', regular: 30000, supplementary: 0, withheld: 0, method: 'cam', gross: 30000 }]
    const r = periodWithholding({ regular: 30000, supplementary: 0, payDate: '2026-05-31', frequency: 'monthly', brackets: monthly, ytd, prior })
    expect(r.n).toBe(5) // January to May, April once
  })

  it('semi-monthly: the previous employer\'s January is two periods, the gap to July none', () => {
    const prior = { taxable: 30000, withheld: 0, employedFrom: '2026-01-01', employedTo: '2026-01-31' }
    const r = periodWithholding({ regular: 15000, supplementary: 0, payDate: '2026-07-15', frequency: 'semi_monthly', brackets: semiMonthly, ytd: [], prior })
    expect(r.n).toBe(3)
  })

  it('weekly: whole weeks of each job, the gap between them not counted', () => {
    // previous employer Jan 5–Jan 30 (4 weeks); this employer pays Mar 6 (its first week)
    const prior = { taxable: 20000, withheld: 0, employedFrom: '2026-01-05', employedTo: '2026-01-30' }
    const r = periodWithholding({ regular: 5000, supplementary: 0, payDate: '2026-03-06', frequency: 'weekly', brackets: BIR_WHT_2023.weekly, ytd: [], prior })
    expect(r.n).toBe(5)
  })

  it('without the previous employer\'s dates: counted straight through, from January 1 when the start is missing', () => {
    const noEnd = { taxable: 60000, withheld: 0, employedFrom: '2026-02-01' }
    expect(periodWithholding({ regular: 30000, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [], prior: noEnd }).n).toBe(5)
    const noDates = { taxable: 60000, withheld: 0 }
    const r = periodWithholding({ regular: 30000, supplementary: 0, payDate: '2026-06-30', frequency: 'monthly', brackets: monthly, ytd: [], prior: noDates })
    expect(r.n).toBe(6)
    expect(r.from).toBe('2026-01-01')
  })

  it('a payroll paid later in the year does not count for an earlier pay date (finalized out of order)', () => {
    // February (S ≥ R) was finalized before January was computed
    const ytd: WithholdingYtdFact[] = [{ payDate: '2026-02-28', regular: 25000, supplementary: 30000, withheld: 6208.4, method: 'cam', gross: 55000 }]
    const r = periodWithholding({ regular: 25000, supplementary: 0, payDate: '2026-01-31', frequency: 'monthly', brackets: monthly, ytd })
    expect(r.method).toBe('regular')
    expectPeso(r.tax, 625.05)
  })

  it('withheld includes refunds and the previous employer\'s tax', () => {
    const ytd: WithholdingYtdFact[] = [
      { payDate: '2026-01-31', regular: 50000, supplementary: 60000, withheld: 20000, gross: 110000 },
      { payDate: '2026-02-28', regular: 50000, supplementary: 0, withheld: -500, gross: 50000 },
    ]
    const r = periodWithholding({ regular: 50000, supplementary: 0, payDate: '2026-03-31', frequency: 'monthly', brackets: monthly, ytd, prior: null })
    expectPeso(r.withheldBefore!, 19500)
    expectPeso(r.tax, Math.max(0, camTotalDue(210000, 3, monthly) - 19500))
  })
})

describe('T2 CAM arithmetic', () => {
  it('total due = n × base + rate × (cum − n × lower bound), exact', () => {
    expectPeso(camTotalDue(64000, 3, monthly), 225.15)
    expectPeso(camTotalDue(80000, 2, monthly), 6416.8)
    expect(camTotalDue(0, 3, monthly)).toBe(0)
    // the average 21,333.33… is never rounded first
    expectPeso(camTotalDue(64000.01, 3, monthly), 225.15)
  })

  it('n: periods of this payroll frequency, both ends included', () => {
    expect(periodsBetween('monthly', '2026-01-31', '2026-03-31')).toBe(3)
    expect(periodsBetween('monthly', '2026-03-05', '2026-03-31')).toBe(1)
    // semi-monthly: Feb 10 (first half) to Jun 20 (second half) = 10 periods
    expect(periodsBetween('semi_monthly', '2026-02-10', '2026-06-20')).toBe(10)
    expect(periodsBetween('semi_monthly', '2026-01-15', '2026-01-16')).toBe(2)
    expect(periodsBetween('weekly', '2026-01-02', '2026-03-06')).toBe(10)
    expect(periodsBetween('monthly', '2026-03-31', '2026-01-31')).toBe(1)
  })

  it('semi-monthly CAM uses the semi-monthly table', () => {
    const r = periodWithholding({ regular: 9000, supplementary: 3000, payDate: '2026-01-15', frequency: 'semi_monthly', brackets: semiMonthly, ytd: [] })
    // R 9,000 is in the 0% row and S > 0: trigger (a); one period, so the table on 12,000
    expect(r.method).toBe('cam')
    expectPeso(r.tax, 0.15 * (12000 - 10417))
  })
})

describe('T2 R and S of a stored payslip', () => {
  const base = {
    pay_date: '2026-03-31', run_type: 'regular', is_minimum_wage_earner: false, withholding_tax: 100, gross_pay: 18500,
    sss_ee: 700, sss_mpf_ee: 0, philhealth_ee: 200, pagibig_ee: 100, union_dues: 0,
  }

  it('uses the stored split when the payslip has one', () => {
    const f = withholdingFactOf({ ...base, earnings: [], taxable_income: 17500, taxable_regular: 15000, taxable_supplementary: 2500, wht_method: 'cam' })
    expect(f).toEqual({ payDate: '2026-03-31', regular: 15000, supplementary: 2500, withheld: 100, method: 'cam', gross: 18500 })
  })

  it('derives it for a payslip from before this change: contributions come out of R first', () => {
    const f = withholdingFactOf({
      ...base,
      earnings: [
        { code: 'basic', amount: 15000, bir: 'basic', taxable: true },
        { code: 'ot', amount: 2000, bir: 'overtime', taxable: true },
        { code: 'allowance', amount: 1000, bir: 'other_taxable', taxable: true },
        { code: 'adjustment', amount: 500, bir: 'other_taxable', taxable: true },
      ],
      taxable_income: 17500,
    })
    expect(f.regular).toBe(15000) // 15,000 + 1,000 − 1,000 contributions
    expect(f.supplementary).toBe(2500) // overtime + the one-time pay
    expect(f.method).toBeUndefined()
  })

  it('an MWE\'s contributions come out of the exempt basic pay', () => {
    const f = withholdingFactOf({
      ...base,
      is_minimum_wage_earner: true,
      earnings: [
        { code: 'basic', amount: 8000, bir: 'basic', taxable: false },
        { code: 'ot', amount: 1000, bir: 'overtime', taxable: false },
        { code: 'allowance', amount: 500, bir: 'other_taxable', taxable: true },
      ],
      taxable_income: 500,
    })
    expect(f.regular).toBe(500)
    expect(f.supplementary).toBe(0)
  })

  it('a taxable 13th month or bonus excess (no taxable line) is S', () => {
    const f = withholdingFactOf({ ...base, run_type: 'thirteenth_month', earnings: [{ code: 'thirteenth', amount: 100000, bir: 'thirteenth', taxable: false }], taxable_income: 10000 })
    expect(f.regular).toBe(0)
    expect(f.supplementary).toBe(10000)
  })
})
