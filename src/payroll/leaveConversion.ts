// Leave cash conversions at the year-end adjustment (spec T7, owner's answer
// 2026-10-25): payroll classifies each conversion under the client's leave
// policy when it is paid; when an admin changes the policy during the year,
// the year-end adjustment (and the 2316 and alphalist built the same way)
// reclassifies the whole year's conversions under the policy in force.

import type { AnnualPayslipFact } from './annual'
import { round2, type LeavePolicy } from './types'

const LEAVE_CONVERSION = 'LEAVE_CONVERSION'

type Line = AnnualPayslipFact['earnings'][number]

// Basis: RR 2-98 §2.78.1(A)(3), as amended by RR 29-2025 §1 (item (a): cash conversion of unused vacation leave, 12 days a year). Labor Code (PD 442) Art. 95 (SIL). Owner, 2026-10-25: a policy changed during the year applies to the year's conversions at the year-end adjustment.
/**
 * The year's leave cash conversions under `policy`, in pay-date order:
 * vacation leave in place of SIL — de minimis up to `daysCeiling` days a
 * year (all of it when no ceiling is on file), the rest to the ₱90k bucket;
 * SIL only — taxable supplementary compensation. Payslips whose
 * conversions come out the same are returned as they were; a conversion
 * without its days is left alone.
 */
export function reclassifyLeaveConversions(
  facts: readonly AnnualPayslipFact[],
  policy: LeavePolicy,
  daysCeiling: number | null,
): { facts: AnnualPayslipFact[]; changed: number } {
  const order = facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.payDate ?? a.f.payMonth).localeCompare(b.f.payDate ?? b.f.payMonth) || a.i - b.i)
  const out = [...facts]
  let used = 0
  let changed = 0
  for (const { f, i } of order) {
    const lines = f.earnings.filter((l) => l.payCode === LEAVE_CONVERSION)
    if (lines.length === 0 || lines.some((l) => !(Number(l.days) > 0))) continue
    const amount = round2(lines.reduce((s, l) => s + l.amount, 0))
    const days = round2(lines.reduce((s, l) => s + Number(l.days), 0))
    let next: Line[]
    if (policy === 'sil_only') {
      next = [{ amount, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary', payCode: LEAVE_CONVERSION, days }]
    } else {
      const withinDays = daysCeiling === null ? days : Math.min(days, Math.max(0, daysCeiling - used))
      used = round2(used + withinDays)
      const within = round2((amount * withinDays) / days)
      const excess = round2(amount - within)
      next = [
        ...(within > 0 ? [{ amount: within, bir: 'de_minimis' as const, taxable: false, payCode: LEAVE_CONVERSION, days: withinDays }] : []),
        ...(excess > 0 ? [{ amount: excess, bir: 'other_benefits' as const, taxable: false, payCode: LEAVE_CONVERSION, days: round2(days - withinDays) }] : []),
      ]
    }
    const same =
      next.length === lines.length && next.every((l, k) => l.bir === lines[k].bir && l.amount === lines[k].amount && (l.taxable ?? false) === (lines[k].taxable ?? false))
    if (same) continue
    out[i] = { ...f, earnings: [...f.earnings.filter((l) => l.payCode !== LEAVE_CONVERSION), ...next] }
    changed += 1
  }
  return { facts: out, changed }
}
