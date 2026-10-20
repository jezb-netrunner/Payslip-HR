import type { Entity, Payslip } from './db'
import { round2 } from '../payroll/types'

export type PayslipEmployer = Pick<Entity, 'name' | 'registered_address' | 'tin' | 'tin_branch_code' | 'payslip_footer_note'>

/**
 * The employer as it stood when the payslip was computed (saved in its
 * snapshot): a re-download of an old payslip must not show a later name,
 * address or TIN.
 */
export function employerFor(slip: Pick<Payslip, 'employee_snapshot'>, current: PayslipEmployer): PayslipEmployer {
  const e = (slip.employee_snapshot as { employer?: { name?: string; tin?: string; address?: string } } | null)?.employer
  if (!e) return current
  return {
    ...current,
    name: e.name || current.name,
    tin: e.tin ?? current.tin,
    registered_address: e.address ?? current.registered_address,
  }
}

export interface RoundingLine {
  label: string
  amount: number
}

/**
 * The cash-rounding steps between the computed net pay and the whole-peso
 * amount paid, one payslip line each. Empty when nothing was rounded.
 */
export function roundingLines(
  slip: Pick<Payslip, 'rounding_adjustment' | 'rounding_carry_in' | 'rounding_carry_out'>,
): RoundingLine[] {
  const carryIn = Number(slip.rounding_carry_in)
  const carryOut = Number(slip.rounding_carry_out)
  const rest = round2(Number(slip.rounding_adjustment) - carryIn + carryOut)
  const lines: RoundingLine[] = []
  if (carryIn > 0) lines.push({ label: 'Centavos carried from the last payout', amount: carryIn })
  if (rest !== 0) lines.push({ label: rest > 0 ? 'Rounded up to whole pesos' : 'Cash rounding', amount: rest })
  if (carryOut > 0) lines.push({ label: 'Centavos carried to the next payout', amount: -carryOut })
  return lines
}
