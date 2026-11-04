import { describe, expect, it } from 'vitest'
import { controlTotals, type ControlSlip } from './controlTotals'

function slip(name: string, earnings: number[], deductions: number[], extra: Partial<ControlSlip> = {}): ControlSlip {
  const gross = earnings.reduce((a, b) => a + b, 0)
  const ded = deductions.reduce((a, b) => a + b, 0)
  return {
    employee_snapshot: { name },
    earnings: earnings.map((amount, i) => ({ label: `E${i}`, amount, category: 'basic' })),
    deductions: deductions.map((amount, i) => ({ label: `D${i}`, amount })),
    gross_pay: gross,
    total_deductions: ded,
    net_pay: gross - ded,
    rounding_adjustment: 0,
    withholding_tax: 0,
    control_no: null,
    ...extra,
  } as ControlSlip
}

describe('payroll control totals', () => {
  const a = slip('Ana Reyes', [10000, 500.25], [450, 250, 125.1], { withholding_tax: 125.1 })
  const b = slip('Ben Cruz', [8000], [400], { rounding_adjustment: 0.4, net_pay: 7600.4 })

  it('balances when every payslip adds up and the run totals equal the payslips', () => {
    const c = controlTotals([a, b], { employees: 2, gross: 18500.25, net: 17275.55, withholding_tax: 125.1 })
    expect(c).toMatchObject({ payslips: 2, gross: 18500.25, deductions: 1225.1, rounding: 0.4, net: 17275.55, withholdingTax: 125.1 })
    expect(c.unbalanced).toEqual([])
    expect(c.mismatches).toEqual([])
    expect(c.balanced).toBe(true)
  })

  it('names the payslip whose lines do not add up', () => {
    const wrongGross = { ...a, gross_pay: 10600.25 }
    const wrongNet = { ...b, net_pay: 7600 }
    const c = controlTotals([wrongGross, wrongNet], { gross: 18600.25, net: 17275.15, withholding_tax: 125.1 })
    expect(c.unbalanced).toEqual(['Ana Reyes', 'Ben Cruz'])
    expect(c.balanced).toBe(false)
  })

  it('reports run totals that differ from the payslips, or are missing', () => {
    const c = controlTotals([a, b], { employees: 2, gross: 18500.24, withholding_tax: 125.1 })
    expect(c.mismatches).toEqual([
      { field: 'gross', run: 18500.24, payslips: 18500.25 },
      { field: 'net', run: null, payslips: 17275.55 },
    ])
    expect(c.balanced).toBe(false)
  })

  it('tolerates float noise below half a centavo', () => {
    const c = controlTotals([slip('X', [0.1, 0.2], [])], { gross: 0.3, net: 0.3, withholding_tax: 0 })
    expect(c.balanced).toBe(true)
  })

  it('gives the payslip control number range in numeric order', () => {
    const numbered = [
      { ...a, control_no: 'PS-000010' },
      { ...b, control_no: 'PS-000009' },
      { ...a, control_no: 'PS-1000000' },
    ]
    const c = controlTotals(numbered, {})
    expect([c.firstNo, c.lastNo]).toEqual(['PS-000009', 'PS-1000000'])
    expect(controlTotals([a], {}).firstNo).toBeNull()
  })

  it('an empty run is not "in balance"', () => {
    expect(controlTotals([], { gross: 0, net: 0, withholding_tax: 0 }).balanced).toBe(false)
  })
})
