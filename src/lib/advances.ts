// Cash advances: a balance-tracked recurring deduction (category
// 'cash_advance') repaid by each finalized payroll and by repayments made
// outside payroll. The ledger is rebuilt from those two sources, so it always
// shows where every peso went.

import type { AdvanceRepayment, Payslip, RecurringDeduction } from './db'
import { round2 } from '../payroll/types'

export type AdvanceStatus = 'active' | 'scheduled' | 'paused' | 'paid'

export function advanceStatus(a: Pick<RecurringDeduction, 'balance' | 'active' | 'start_date'>, today: string): AdvanceStatus {
  if (Number(a.balance ?? 0) <= 0) return 'paid'
  if (!a.active) return 'paused'
  if (a.start_date && a.start_date > today) return 'scheduled'
  return 'active'
}

export const ADVANCE_STATUS_LABELS: Record<AdvanceStatus, string> = {
  active: 'Repaying',
  scheduled: 'Starts later',
  paused: 'Paused',
  paid: 'Fully paid',
}

export const ADVANCE_STATUS_TONES: Record<AdvanceStatus, string> = {
  active: 'blue',
  scheduled: 'violet',
  paused: 'amber',
  paid: 'green',
}

/** How many payrolls an amount takes at a given deduction per payroll. */
export function payrollsToRepay(amount: number, perPayroll: number): number {
  const a = Math.round(amount * 100)
  const p = Math.round(perPayroll * 100)
  return a > 0 && p > 0 ? Math.ceil(a / p) : 0
}

/** The payslip's own run facts: employees' payslips carry them; admins also read the run's status. */
export type LedgerSlip = Pick<Payslip, 'payroll_run_id' | 'deductions' | 'pay_date' | 'period_start' | 'period_end'> & {
  /** false = a draft payroll: its deduction is only scheduled. Employees only ever see finalized payslips. */
  finalized: boolean
}

export interface LedgerEntry {
  date: string
  kind: 'released' | 'payroll' | 'repayment' | 'scheduled'
  /** + released, − repaid */
  amount: number
  /** Owed after this entry; null for a deduction still in a draft payroll. */
  balance: number | null
  periodStart?: string | null
  periodEnd?: string | null
  repaymentId?: string
  note?: string
}

export interface AdvanceLedger {
  entries: LedgerEntry[]
  /** Repaid so far: finalized payrolls plus repayments outside payroll. */
  paid: number
  /** Balance on record minus what the ledger says is owed: 0 unless it was edited by hand before advances had a ledger. */
  unexplained: number
}

export function advanceLedger(
  advance: Pick<RecurringDeduction, 'id' | 'total_amount' | 'balance' | 'released_on' | 'created_at'>,
  slips: LedgerSlip[],
  repayments: Pick<AdvanceRepayment, 'id' | 'paid_on' | 'amount' | 'notes'>[],
): AdvanceLedger {
  const total = Number(advance.total_amount ?? 0)
  const moves: LedgerEntry[] = []
  const scheduled: LedgerEntry[] = []
  for (const s of slips) {
    const amount = (s.deductions ?? [])
      .filter((l) => l.meta === advance.id)
      .reduce((sum, l) => sum + Number(l.amount), 0)
    if (amount <= 0) continue
    const entry: LedgerEntry = {
      date: s.pay_date ?? s.period_end ?? '',
      kind: s.finalized ? 'payroll' : 'scheduled',
      amount: -round2(amount),
      balance: null,
      periodStart: s.period_start,
      periodEnd: s.period_end,
    }
    if (s.finalized) moves.push(entry)
    else scheduled.push(entry)
  }
  for (const r of repayments) {
    moves.push({ date: r.paid_on, kind: 'repayment', amount: -round2(Number(r.amount)), balance: null, repaymentId: r.id, note: r.notes || undefined })
  }
  moves.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'payroll' ? -1 : 1))

  let owed = round2(total)
  const entries: LedgerEntry[] = [
    { date: advance.released_on ?? advance.created_at?.slice(0, 10) ?? '', kind: 'released', amount: owed, balance: owed },
  ]
  for (const m of moves) {
    owed = round2(owed + m.amount)
    entries.push({ ...m, balance: owed })
  }
  entries.push(...scheduled.sort((a, b) => a.date.localeCompare(b.date)))
  const paid = round2(total - owed)
  return { entries, paid, unexplained: round2(Number(advance.balance ?? 0) - owed) }
}

/** What the next payroll is set to deduct across these advances (installment capped at each balance). */
export function nextInstallment(advances: Pick<RecurringDeduction, 'balance' | 'amount_per_period' | 'active'>[]): number {
  return round2(
    advances
      .filter((a) => a.active && Number(a.balance ?? 0) > 0)
      .reduce((sum, a) => sum + Math.min(Number(a.amount_per_period), Number(a.balance)), 0),
  )
}
