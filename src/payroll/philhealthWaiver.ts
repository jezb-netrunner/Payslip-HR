// PhilHealth's national government share (the NG share) of the employee
// premium, by payroll month (spec T6): solo parents (RA 11861) and employed
// PWDs (RA 11228). The employer share never changes; in a waived month
// nothing is deducted, so nothing is excluded from taxable pay either.

import { addDays, addMonths, endOfMonth } from '../lib/manila'
import { round2 } from './types'

export interface PhilhealthWaiverRecord {
  kind: 'pwd' | 'solo_parent' | null
  /** first month of the NG share (YYYY-MM-01): PhilHealth's tagging (solo parent), the month the complete requirements went in (PWD) */
  startMonth: string | null
  /** solo parent: the SPIC's expiry */
  spicExpiry: string | null
  /** PWD: PhilHealth's status */
  pwdStatus: 'for_verification' | 'confirmed' | null
}

// Basis: PhilHealth Circular 2026-0015 (effective on publication, Sep 26, 2026): V.A, V.C, V.E.5, V.E.6, V.F.2 (the NG share is "non-collectible from the solo parent"). PhilHealth Circular 2026-0017 (effective on publication, Oct 9, 2026): V.F.1 ("For Verification" members continue paying) and V.H.2 (the NG share is non-collectible "beginning in the month when the employer submits the complete requirements"). RA 11228 (approved Feb 22, 2019).
/**
 * Whether the NG share pays the employee share for payroll month `month`
 * (YYYY-MM-01): from the start month on — for a solo parent only in a month a
 * valid SPIC fully covers, for a PWD only once PhilHealth confirmed the status.
 */
export function philhealthWaiverFor(w: PhilhealthWaiverRecord, month: string): 'pwd' | 'solo_parent' | undefined {
  if (!w.kind || !w.startMonth || month < w.startMonth) return undefined
  if (w.kind === 'solo_parent') return w.spicExpiry && w.spicExpiry >= endOfMonth(month) ? 'solo_parent' : undefined
  return w.pwdStatus === 'confirmed' ? 'pwd' : undefined
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`
const dateText = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1].slice(0, 3)} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`

/**
 * What the payroll of `month` (ending `periodEnd`) should tell the admin: a
 * PWD still for verification, a month no valid SPIC covers, or an SPIC that
 * expires within 30 days.
 */
export function philhealthWaiverWarnings(w: PhilhealthWaiverRecord, month: string, periodEnd: string): string[] {
  if (!w.kind || !w.startMonth || month < w.startMonth) return []
  if (w.kind === 'pwd') {
    return w.pwdStatus === 'confirmed'
      ? []
      : ['PhilHealth status "for verification": the PWD\'s employee share is deducted as usual until PhilHealth confirms it.']
  }
  if (!w.spicExpiry) {
    return ['No solo parent ID (SPIC) expiry on file: the PhilHealth employee share is deducted. Record the SPIC\'s expiry to apply the NG share.']
  }
  if (w.spicExpiry < endOfMonth(month)) {
    return [
      `No valid solo parent ID (SPIC) covers ${monthName(month)} (it expires on ${dateText(w.spicExpiry)}): the PhilHealth employee share is deducted. Record the renewed SPIC's expiry to restore the NG share.`,
    ]
  }
  if (w.spicExpiry <= addDays(periodEnd, 30)) {
    // the first month it no longer fully covers
    const firstOfExpiryMonth = `${w.spicExpiry.slice(0, 7)}-01`
    const uncovered = w.spicExpiry === endOfMonth(w.spicExpiry) ? addMonths(firstOfExpiryMonth, 1) : firstOfExpiryMonth
    return [
      `The solo parent ID (SPIC) expires on ${dateText(w.spicExpiry)}: ask for the renewed SPIC and record its expiry. Without it, the PhilHealth employee share is deducted from ${monthName(uncovered)}.`,
    ]
  }
  return []
}

/**
 * Finalized payslips of months the NG share now covers that still deducted
 * the employee share (the waiver was confirmed or recorded late): by month,
 * for a manual adjustment.
 */
export function pastWaivedDeductions(
  w: PhilhealthWaiverRecord,
  slips: readonly { period_month: string | null; philhealth_ee: number | string }[],
): { month: string; amount: number }[] {
  const byMonth = new Map<string, number>()
  for (const p of slips) {
    const amount = Number(p.philhealth_ee)
    if (!p.period_month || !(amount > 0) || !philhealthWaiverFor(w, p.period_month)) continue
    byMonth.set(p.period_month, round2((byMonth.get(p.period_month) ?? 0) + amount))
  }
  return [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount }))
}
