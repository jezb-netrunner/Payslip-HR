// Expanded withholding tax (EWT) on consultants' fees, and the payor's BIR
// outputs: the 2307 figures per payee per quarter, the 1601-EQ summary (with
// the 0619-E remittances of the quarter's first two months) and the
// Quarterly Alphalist of Payees. The rates are data (ewt_versions, shipped
// as migrations); the database withholds each billing with the same rule as
// ewtRuleFor (consultant_billing_ewt), which the app uses for previews.

import { round2 } from './types'

export type PayeeType = 'individual' | 'juridical'

export interface EwtBand {
  rate: number
  atc: string
}

export interface EwtPayeeRules {
  /** gross income for the year: up to it the rate within, above it the rate above */
  threshold: number
  within: EwtBand
  above: EwtBand
  /** a VAT-registered payee is withheld at the rate above */
  vat_registered_above: boolean
  /** without the payee's sworn declaration for the year, the rate above */
  no_declaration_above: boolean
}

/** A kind of fee: its label and the rules per payee type (its ATCs). */
export interface EwtFeeKind {
  label: string
  individual: EwtPayeeRules
  juridical: EwtPayeeRules
}

export interface EwtData {
  /** by kind of fee: professional (licensed professionals), consultancy (management and technical consultants) */
  fees: Record<string, EwtFeeKind>
}

export interface EwtVersion {
  effective_from: string
  description: string
  legal_basis: string
  source_url: string
  verified_on: string | null
  data: EwtData
}

/** The EWT table in force on a date: the newest from on or before it. */
export function ewtVersionOn<T extends Pick<EwtVersion, 'effective_from'>>(versions: T[], date: string): T | undefined {
  return [...versions].filter((v) => v.effective_from <= date).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
}

export type EwtReason = 'declared_over' | 'no_declaration' | 'vat_registered' | 'billed_over' | 'declared_within'

/**
 * The rate and ATC a fee is withheld at, and why (mirrors
 * consultant_billing_ewt): the kind of fee and payee type pick the rules;
 * the payee's declaration for the year, VAT registration, and what the
 * client billed it this year (ytd, this fee included) pick the band.
 * Undefined when the table has no such kind of fee.
 */
export function ewtRuleFor(
  data: EwtData,
  payee: { payee_type: PayeeType; vat_registered: boolean; fee_kind: string },
  declaration: { over_threshold: boolean } | null | undefined,
  ytd = 0,
): (EwtBand & { reason: EwtReason; threshold: number }) | undefined {
  const r = data.fees[payee.fee_kind]?.[payee.payee_type]
  if (!r) return undefined
  const reason: EwtReason = declaration?.over_threshold
    ? 'declared_over'
    : !declaration && r.no_declaration_above
      ? 'no_declaration'
      : payee.vat_registered && r.vat_registered_above
        ? 'vat_registered'
        : ytd > r.threshold
          ? 'billed_over'
          : 'declared_within'
  const band = reason === 'declared_within' ? r.within : r.above
  return { ...band, reason, threshold: r.threshold }
}

/** What the client billed a payee in the year before a billing (by date, then entry). */
export function billedBefore(
  billings: { id: string; consultant_id: string; billed_on: string; created_at: string; gross_amount: number }[],
  consultantId: string,
  billedOn: string,
  editingId?: string,
): number {
  const year = billedOn.slice(0, 4)
  const editing = billings.find((b) => b.id === editingId)
  return round2(
    billings
      .filter(
        (b) =>
          b.consultant_id === consultantId &&
          b.id !== editingId &&
          b.billed_on.slice(0, 4) === year &&
          (b.billed_on < billedOn || (b.billed_on === billedOn && (!editing || b.created_at < editing.created_at || (b.created_at === editing.created_at && b.id < editing.id)))),
      )
      .reduce((s, b) => s + Number(b.gross_amount), 0),
  )
}

export function ewtAmount(gross: number, rate: number): number {
  return round2(gross * rate)
}

// ---------- quarters ----------

export interface Quarter {
  /** first day, YYYY-MM-01 */
  start: string
  /** last day */
  end: string
  label: string
  /** the three months, YYYY-MM */
  months: [string, string, string]
}

const pad = (n: number) => String(n).padStart(2, '0')
const MONTH_DAYS = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function quarterOf(date: string): Quarter {
  const y = Number(date.slice(0, 4))
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3)
  const m1 = q * 3 + 1
  return {
    start: `${y}-${pad(m1)}-01`,
    end: `${y}-${pad(m1 + 2)}-${pad(MONTH_DAYS(y, m1 + 2))}`,
    label: `Q${q + 1} ${y}`,
    months: [`${y}-${pad(m1)}`, `${y}-${pad(m1 + 1)}`, `${y}-${pad(m1 + 2)}`],
  }
}

// ---------- the payor's outputs ----------

export interface BillingFact {
  consultant_id: string
  billed_on: string
  gross_amount: number
  atc: string
  ewt_rate: number
  ewt_amount: number
}

/** BIR Form 2307 figures for one payee and quarter: per ATC, the income paid each month and the tax withheld. */
export interface Form2307Row {
  atc: string
  rate: number
  months: [number, number, number]
  total: number
  withheld: number
}

export function form2307Rows(billings: BillingFact[], quarter: Quarter): Form2307Row[] {
  const byAtc = new Map<string, Form2307Row>()
  for (const b of billings) {
    if (b.billed_on < quarter.start || b.billed_on > quarter.end) continue
    const row = byAtc.get(b.atc) ?? { atc: b.atc, rate: Number(b.ewt_rate), months: [0, 0, 0] as [number, number, number], total: 0, withheld: 0 }
    const k = quarter.months.indexOf(b.billed_on.slice(0, 7))
    row.months[k] = round2(row.months[k] + Number(b.gross_amount))
    row.total = round2(row.total + Number(b.gross_amount))
    row.withheld = round2(row.withheld + Number(b.ewt_amount))
    byAtc.set(b.atc, row)
  }
  return [...byAtc.values()].sort((a, b) => a.atc.localeCompare(b.atc))
}

/** BIR 1601-EQ: per ATC the tax base, rate and tax withheld; and what the 0619-E of the first two months remitted. */
export interface Return1601Eq {
  rows: { atc: string; rate: number; base: number; withheld: number }[]
  total: number
  /** withheld in each month of the quarter: the first two are remitted with 0619-E */
  byMonth: [number, number, number]
}

export function return1601Eq(billings: BillingFact[], quarter: Quarter): Return1601Eq {
  const rows = new Map<string, { atc: string; rate: number; base: number; withheld: number }>()
  const byMonth: [number, number, number] = [0, 0, 0]
  for (const b of billings) {
    if (b.billed_on < quarter.start || b.billed_on > quarter.end) continue
    const key = `${b.atc}|${Number(b.ewt_rate)}`
    const r = rows.get(key) ?? { atc: b.atc, rate: Number(b.ewt_rate), base: 0, withheld: 0 }
    r.base = round2(r.base + Number(b.gross_amount))
    r.withheld = round2(r.withheld + Number(b.ewt_amount))
    rows.set(key, r)
    const k = quarter.months.indexOf(b.billed_on.slice(0, 7))
    byMonth[k] = round2(byMonth[k] + Number(b.ewt_amount))
  }
  const list = [...rows.values()].sort((a, b) => a.atc.localeCompare(b.atc))
  return { rows: list, total: round2(list.reduce((s, r) => s + r.withheld, 0)), byMonth }
}

export interface PayeeFacts {
  id: string
  payee_type: PayeeType
  tin: string
  tin_branch_code: string
  last_name: string
  first_name: string
  middle_name: string
  registered_name: string
  service: string
}

/** The Quarterly Alphalist of Payees: one row per payee and ATC. */
export interface QapRow {
  seq: number
  tin: string
  branch: string
  registeredName: string
  lastName: string
  firstName: string
  middleName: string
  atc: string
  nature: string
  income: number
  rate: number
  withheld: number
}

export function qapRows(payees: PayeeFacts[], billings: BillingFact[], quarter: Quarter): QapRow[] {
  const byId = new Map(payees.map((p) => [p.id, p]))
  const sorted = [...payees].sort((a, b) => payeeName(a).localeCompare(payeeName(b)))
  const rows: QapRow[] = []
  for (const p of sorted) {
    for (const r of form2307Rows(billings.filter((b) => b.consultant_id === p.id), quarter)) {
      rows.push({
        seq: rows.length + 1,
        tin: p.tin.replace(/\D/g, ''),
        branch: p.tin_branch_code,
        registeredName: p.payee_type === 'juridical' ? p.registered_name : '',
        lastName: p.payee_type === 'individual' ? p.last_name : '',
        firstName: p.payee_type === 'individual' ? p.first_name : '',
        middleName: p.payee_type === 'individual' ? p.middle_name : '',
        atc: r.atc,
        nature: byId.get(p.id)?.service ?? '',
        income: r.total,
        rate: r.rate,
        withheld: r.withheld,
      })
    }
  }
  return rows
}

export function payeeName(p: Pick<PayeeFacts, 'payee_type' | 'last_name' | 'first_name' | 'middle_name' | 'registered_name'>): string {
  return p.payee_type === 'juridical'
    ? p.registered_name
    : `${p.last_name}, ${p.first_name}${p.middle_name ? ` ${p.middle_name}` : ''}`
}
