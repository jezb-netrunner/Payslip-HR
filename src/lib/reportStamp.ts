// What every system-generated report shows on its printout and electronic
// copy (BIR RMO 9-2021 Annex B, item 4): the taxpayer's registered name and
// address, "VAT REG TIN" or "NON-VAT REG TIN" with the branch code, the
// software name and version, who generated the report and when.

import { SOFTWARE } from './appInfo'
import { fmtTin } from './format'

export interface StampCompany {
  id?: string | null
  name: string
  registered_address: string
  tin: string
  tin_branch_code: string
  /** null: not set in Client Settings yet (the TIN prints without the VAT status) */
  vat_registered?: boolean | null
}

export interface StampUser {
  full_name?: string | null
  email?: string | null
}

export interface ReportStamp {
  title: string
  entityId: string | null
  company: string
  address: string
  tinLine: string
  software: string
  generatedBy: string
  generatedAt: string
}

/** "VAT REG TIN 123-456-789-00000", "NON-VAT REG TIN …", or "TIN …" while the status is not set. */
export function tinLine(c: { tin?: string | null; tin_branch_code?: string | null; vat_registered?: boolean | null }): string {
  const tin = fmtTin(c.tin, c.tin_branch_code)
  if (!tin) return ''
  if (c.vat_registered === true) return `VAT REG TIN ${tin}`
  if (c.vat_registered === false) return `NON-VAT REG TIN ${tin}`
  return `TIN ${tin}`
}

/** "Ana Cruz (ana@acme.ph)", or whichever of the two is known. */
export function userLabel(u: StampUser | null | undefined): string {
  const name = (u?.full_name ?? '').trim()
  const email = (u?.email ?? '').trim()
  if (name && email) return `${name} (${email})`
  return name || email || 'unknown user'
}

/** Date and time in Philippine time: "Oct 29, 2026, 9:15 AM". */
export function manilaStamp(at: Date): string {
  return at.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function makeStamp(title: string, company: StampCompany | null, user: StampUser | null, at = new Date()): ReportStamp {
  return {
    title,
    entityId: company?.id ?? null,
    company: company?.name ?? '',
    address: company?.registered_address ?? '',
    tinLine: company ? tinLine(company) : '',
    software: SOFTWARE,
    generatedBy: userLabel(user),
    generatedAt: manilaStamp(at),
  }
}

/** The heading rows of a CSV or Excel export, then an empty row. */
export function stampRows(s: ReportStamp): string[][] {
  return [
    [s.company],
    ...(s.address ? [[s.address]] : []),
    ...(s.tinLine ? [[s.tinLine]] : []),
    [s.title],
    [`Generated ${s.generatedAt} by ${s.generatedBy}`],
    [s.software],
    [],
  ]
}

/** One line for the foot of a printed page. */
export function stampFooter(s: ReportStamp): string {
  return `Generated ${s.generatedAt} by ${s.generatedBy} • ${s.software}`
}

/** The foot line of an HTML print sheet; `esc` is the sheet's HTML escaper. */
export function stampHtml(s: ReportStamp, esc: (v: string) => string): string {
  return `<p style="margin:14px 0 0;font-size:10px;color:#64748b">${esc(stampFooter(s))}</p>`
}
