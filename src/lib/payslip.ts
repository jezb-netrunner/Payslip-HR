import type { Entity, Payslip } from './db'
import { round2 } from '../payroll/types'

export type PayslipEmployer = Pick<Entity, 'id' | 'name' | 'registered_address' | 'tin' | 'tin_branch_code' | 'vat_registered' | 'payslip_footer_note'>

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

/**
 * The pay rate the payslip was computed at (its snapshot): the amount and
 * its basis, or null when the snapshot has none (a worker paid by results
 * alone, or a payslip from before rates were kept).
 */
export function payslipRate(slip: Pick<Payslip, 'employee_snapshot'>): { amount: number; per: 'month' | 'day' } | null {
  const snap = (slip.employee_snapshot ?? {}) as { pay_type?: string; monthly_rate?: number | string; daily_rate?: number | string }
  const daily = snap.pay_type === 'daily'
  const amount = Number(daily ? snap.daily_rate : snap.monthly_rate)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { amount, per: daily ? 'day' : 'month' }
}

export interface AttendanceFact {
  label: string
  value: string
}

/**
 * The attendance a payslip paid, for the employee to check against their
 * own record: days and hours always (when any), the rest only when not zero.
 * Empty for a 13th month payslip or one that paid no attendance.
 */
export function attendanceFacts(
  slip: Pick<
    Payslip,
    'run_type' | 'days_worked' | 'hours_worked' | 'overtime_hours' | 'night_diff_hours' | 'late_minutes' | 'undertime_minutes' | 'absent_days'
  >,
): AttendanceFact[] {
  if (slip.run_type === 'thirteenth_month') return []
  const n = (v: unknown) => Number(v ?? 0) || 0
  const days = n(slip.days_worked)
  const hours = n(slip.hours_worked)
  const absent = n(slip.absent_days)
  if (days <= 0 && hours <= 0 && absent <= 0) return []
  const num = (v: number) => String(round2(v))
  const facts: AttendanceFact[] = [
    { label: 'Days worked', value: num(days) },
    { label: 'Hours', value: num(hours) },
  ]
  const extra: [string, number, string][] = [
    ['Overtime', n(slip.overtime_hours), ' h'],
    ['Night differential', n(slip.night_diff_hours), ' h'],
    ['Late', n(slip.late_minutes), ' min'],
    ['Undertime', n(slip.undertime_minutes), ' min'],
    ['Absent / unpaid leave', absent, absent === 1 ? ' day' : ' days'],
  ]
  for (const [label, v, unit] of extra) if (v > 0) facts.push({ label, value: `${num(v)}${unit}` })
  return facts
}
