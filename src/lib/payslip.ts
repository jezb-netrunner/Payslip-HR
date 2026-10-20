import type { Entity, Payslip } from './db'

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
