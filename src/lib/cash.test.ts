import { describe, expect, it } from 'vitest'
import { denominationBreakdown, sumBreakdowns } from './cash'

describe('cash denomination breakdown', () => {
  it('uses the fewest bills and coins', () => {
    const b = denominationBreakdown(4197)
    expect(b.counts).toEqual({ 1000: 4, 500: 0, 200: 0, 100: 1, 50: 1, 20: 2, 10: 0, 5: 1, 1: 2 })
    expect(b.centavos).toBe(0)
  })

  it('reports leftover centavos when net pay is not rounded', () => {
    expect(denominationBreakdown(4196.54).centavos).toBe(0.54)
  })

  it('totals a payroll', () => {
    const total = sumBreakdowns([denominationBreakdown(4197), denominationBreakdown(1235)])
    expect(total.counts[1000]).toBe(5)
    expect(total.counts[200]).toBe(1)
    expect(total.counts[20]).toBe(3)
  })
})
