import { describe, expect, it } from 'vitest'
import { BIR_WHT_2023, DEFAULT_TABLES, PAGIBIG_2024, PHILHEALTH_2024, SSS_2025 } from './defaults'
import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax, sssMsc, taxFromBrackets } from './statutory'

describe('SSS (RA 11199, 15% schedule effective Jan 2025)', () => {
  it('maps salary to MSC brackets like the published table', () => {
    expect(sssMsc(4000, SSS_2025)).toBe(5000) // below floor
    expect(sssMsc(5249.99, SSS_2025)).toBe(5000) // "Below 5,250"
    expect(sssMsc(5250, SSS_2025)).toBe(5500) // "5,250 - 5,749.99"
    expect(sssMsc(5749.99, SSS_2025)).toBe(5500)
    expect(sssMsc(5750, SSS_2025)).toBe(6000)
    expect(sssMsc(34749.99, SSS_2025)).toBe(34500)
    expect(sssMsc(34750, SSS_2025)).toBe(35000) // ceiling bracket
    expect(sssMsc(100000, SSS_2025)).toBe(35000)
  })

  it('computes EE 5% / ER 10% on the MSC', () => {
    const c = computeSss(20000, SSS_2025)
    expect(c.msc).toBe(20000)
    expect(c.ee).toBe(1000)
    expect(c.er).toBe(2000)
    expect(c.mpfEe).toBe(0)
    expect(c.mpfEr).toBe(0)
    expect(c.ecEr).toBe(30)
  })

  it('routes MSC above 20,000 to the MPF (WISP)', () => {
    const c = computeSss(25000, SSS_2025)
    expect(c.msc).toBe(25000)
    expect(c.ee).toBe(1000) // 5% of 20,000
    expect(c.mpfEe).toBe(250) // 5% of 5,000
    expect(c.er).toBe(2000)
    expect(c.mpfEr).toBe(500)
  })

  it('caps at MSC 35,000', () => {
    const c = computeSss(80000, SSS_2025)
    expect(c.msc).toBe(35000)
    expect(c.ee + c.mpfEe).toBe(1750) // 5% of 35,000
    expect(c.er + c.mpfEr).toBe(3500)
  })

  it('uses EC ₱10 below MSC 15,000 and ₱30 at or above (EC keys off the MSC)', () => {
    expect(computeSss(10000, SSS_2025).ecEr).toBe(10)
    expect(computeSss(14700, SSS_2025).ecEr).toBe(10) // maps to MSC 14,500
    expect(computeSss(14999, SSS_2025).ecEr).toBe(30) // 14,750–15,249.99 -> MSC 15,000
    expect(computeSss(15000, SSS_2025).ecEr).toBe(30)
  })
})

describe('PhilHealth (RA 11223, 5% premium)', () => {
  it('applies the ₱10,000 floor', () => {
    const c = computePhilHealth(8000, PHILHEALTH_2024)
    expect(c.total).toBe(500)
    expect(c.ee).toBe(250)
    expect(c.er).toBe(250)
  })

  it('splits 5% equally at mid-range', () => {
    const c = computePhilHealth(25000, PHILHEALTH_2024)
    expect(c.total).toBe(1250)
    expect(c.ee).toBe(625)
  })

  it('applies the ₱100,000 ceiling', () => {
    const c = computePhilHealth(150000, PHILHEALTH_2024)
    expect(c.total).toBe(5000)
    expect(c.ee).toBe(2500)
  })

  it('gives the odd centavo to the employer (official sample convention)', () => {
    // Official PhilHealth sample: total 618.75 -> EE 309.37 / ER 309.38.
    // At 5% that total arises from a 12,375 MBS.
    const c = computePhilHealth(12375, PHILHEALTH_2024)
    expect(c.total).toBe(618.75)
    expect(c.ee).toBe(309.37)
    expect(c.er).toBe(309.38)
  })
})

describe('Pag-IBIG (HDMF, ₱10,000 max fund salary from Feb 2024)', () => {
  it('uses 1% EE below ₱1,500 monthly compensation', () => {
    const c = computePagibig(1200, PAGIBIG_2024)
    expect(c.ee).toBe(12)
    expect(c.er).toBe(24)
  })

  it('uses 2% EE / 2% ER otherwise', () => {
    const c = computePagibig(5000, PAGIBIG_2024)
    expect(c.ee).toBe(100)
    expect(c.er).toBe(100)
  })

  it('caps the fund salary at ₱10,000 (max ₱200 + ₱200)', () => {
    const c = computePagibig(50000, PAGIBIG_2024)
    expect(c.ee).toBe(200)
    expect(c.er).toBe(200)
  })
})

describe('BIR withholding tax (revised tables, 01 Jan 2023 onward)', () => {
  it('semi-monthly: ₱10,417 and below is exempt', () => {
    expect(computeWithholdingTax(10417, 'semi_monthly', BIR_WHT_2023)).toBe(0)
    expect(computeWithholdingTax(9000, 'semi_monthly', BIR_WHT_2023)).toBe(0)
  })

  it('semi-monthly: 15% bracket', () => {
    // (12,500 - 10,417) × 15% = 312.45
    expect(computeWithholdingTax(12500, 'semi_monthly', BIR_WHT_2023)).toBe(312.45)
  })

  it('semi-monthly: 20% bracket with ₱937.50 base', () => {
    // 937.50 + 20% × (20,000 - 16,667) = 1,604.10
    expect(computeWithholdingTax(20000, 'semi_monthly', BIR_WHT_2023)).toBe(1604.1)
  })

  it('monthly: 15% bracket', () => {
    // (25,000 - 20,833) × 15% = 625.05
    expect(computeWithholdingTax(25000, 'monthly', BIR_WHT_2023)).toBe(625.05)
  })

  it('monthly: top bracket', () => {
    // 183,541.80 + 35% × (1,000,000 - 666,667) = 300,208.35
    expect(computeWithholdingTax(1000000, 'monthly', BIR_WHT_2023)).toBe(300208.35)
  })

  it('annual table: ₱250,000 and below is exempt', () => {
    expect(taxFromBrackets(250000, DEFAULT_TABLES.bir_annual.brackets)).toBe(0)
    // 22,500 + 20% × (500,000 - 400,000) = 42,500
    expect(taxFromBrackets(500000, DEFAULT_TABLES.bir_annual.brackets)).toBe(42500)
  })
})
