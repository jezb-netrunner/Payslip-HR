// The control totals of a payroll run (BIR RMO 9-2021 Annex B, item 10):
// each payslip's lines add up to its gross pay and total deductions, its net
// pay is gross less deductions plus the cash rounding, and the run's totals
// equal the sum of its payslips. finalize_payroll_run refuses a run that is
// out of balance by the same rule; this shows the figures beside it.

import type { Payslip, PayrollRun } from '../lib/db'
import { round2 } from './types'

export type ControlSlip = Pick<
  Payslip,
  'employee_snapshot' | 'earnings' | 'deductions' | 'gross_pay' | 'total_deductions' | 'net_pay' | 'rounding_adjustment' | 'withholding_tax' | 'control_no'
>

export interface TotalsMismatch {
  field: 'gross' | 'net' | 'withholding_tax'
  /** the figure saved on the run; null when it has none */
  run: number | null
  payslips: number
}

export interface ControlTotals {
  payslips: number
  gross: number
  deductions: number
  rounding: number
  net: number
  withholdingTax: number
  /** lowest and highest payslip control numbers; null before the run is finalized */
  firstNo: string | null
  lastNo: string | null
  /** employees whose payslip lines do not add up to the payslip's figures */
  unbalanced: string[]
  mismatches: TotalsMismatch[]
  balanced: boolean
}

// the database compares to the half centavo
const off = (a: number, b: number) => Math.abs(a - b) > 0.005
const sum = (lines: { amount: number }[] | null | undefined) => (lines ?? []).reduce((t, l) => t + Number(l.amount), 0)
const seq = (no: string) => Number(no.replace(/\D/g, ''))

export function controlTotals(slips: ControlSlip[], totals: PayrollRun['totals'] | null | undefined): ControlTotals {
  const unbalanced: string[] = []
  let gross = 0
  let deductions = 0
  let rounding = 0
  let net = 0
  let tax = 0
  for (const s of slips) {
    const g = Number(s.gross_pay)
    const d = Number(s.total_deductions)
    const r = Number(s.rounding_adjustment ?? 0)
    const n = Number(s.net_pay)
    if (off(g, sum(s.earnings)) || off(d, sum(s.deductions)) || off(n, g - d + r)) {
      unbalanced.push(String((s.employee_snapshot as Record<string, unknown> | null)?.name ?? 'Unnamed employee'))
    }
    gross += g
    deductions += d
    rounding += r
    net += n
    tax += Number(s.withholding_tax)
  }
  const t = totals ?? {}
  const mismatches: TotalsMismatch[] = []
  const check = (field: TotalsMismatch['field'], payslips: number) => {
    const saved = typeof t[field] === 'number' ? (t[field] as number) : null
    if (saved === null || off(saved, payslips)) mismatches.push({ field, run: saved, payslips: round2(payslips) })
  }
  check('gross', gross)
  check('net', net)
  check('withholding_tax', tax)
  const numbers = slips.map((s) => s.control_no).filter((n): n is string => !!n).sort((a, b) => seq(a) - seq(b))
  return {
    payslips: slips.length,
    gross: round2(gross),
    deductions: round2(deductions),
    rounding: round2(rounding),
    net: round2(net),
    withholdingTax: round2(tax),
    firstNo: numbers[0] ?? null,
    lastNo: numbers[numbers.length - 1] ?? null,
    unbalanced,
    mismatches,
    balanced: slips.length > 0 && unbalanced.length === 0 && mismatches.length === 0,
  }
}
