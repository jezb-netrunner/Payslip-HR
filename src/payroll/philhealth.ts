// PhilHealth for solo parents and persons with disability: the national
// government pays the employee half of the premium; the employer pays its
// usual half, and the government's half is neither deducted nor remitted.
// Basis: PhilHealth Circular 2026-0015 Secs. V.C, V.E.5, V.F.2 (effective
// 26 Sep 2026) and its Q&A; PhilHealth Circular 2026-0017 Sec. V.H
// (effective 9 Oct 2026); RA 11228; RA 11861.

import { PHILHEALTH_NG } from './law'

export type PhilHealthNgType = 'solo_parent' | 'pwd'

export interface PhilHealthNgFields {
  ph_ng_type?: PhilHealthNgType | null
  /** first month: for a solo parent, the first month PhilHealth billing (SPA/EPRS) shows the tag; for a PWD, the month the complete requirements were submitted */
  ph_ng_from_month?: string | null
  /** Solo Parent ID (SPIC) or PWD ID */
  id_number?: string | null
  id_valid_until?: string | null
}

/**
 * Whether the government pays the employee half for a payroll month
 * (YYYY-MM-01): from ph_ng_from_month through the month before the ID's
 * expiry month (a renewed ID continues it).
 */
export function philhealthNgFor(e: PhilHealthNgFields, month: string): PhilHealthNgType | undefined {
  const type = e.ph_ng_type
  if (!type || !e.ph_ng_from_month || !e.id_number?.trim()) return undefined
  if (month < e.ph_ng_from_month) return undefined
  if (type === 'solo_parent' && (month < PHILHEALTH_NG.soloParentFromMonth.value || !e.id_valid_until)) return undefined
  if (e.id_valid_until && month >= `${e.id_valid_until.slice(0, 7)}-01`) return undefined
  return type
}

/** Why the fields can't be saved ('' = fine). */
export function philhealthNgProblem(type: string, fromMonth: string, idNumber: string, validUntil: string): string {
  if (!type) return ''
  if (!fromMonth) return 'Enter the first month the government pays the PhilHealth employee share.'
  if (!idNumber.trim()) return `Enter the ${type === 'solo_parent' ? 'Solo Parent ID (SPIC)' : 'PWD ID'} number.`
  if (type === 'solo_parent' && !validUntil) return 'Enter the date the Solo Parent ID is valid until: the government share stops at its expiry unless a renewed ID is entered.'
  if (validUntil && `${validUntil.slice(0, 7)}-01` <= fromMonth) return 'The ID expires before the first month: enter the renewed ID.'
  if (type === 'solo_parent' && fromMonth < PHILHEALTH_NG.soloParentFromMonth.value) {
    return 'For a solo parent the first month is the first month PhilHealth billing shows the solo-parent tag, not earlier than October 2026 (PhilHealth Circular 2026-0015).'
  }
  return ''
}
