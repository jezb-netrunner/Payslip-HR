import { Trash2 } from 'lucide-react'
import type { LedgerEntry } from '../lib/advances'
import { fmtDate, fmtPeriod, money } from '../lib/format'
import { IconButton } from './ui'

const title = (e: LedgerEntry) =>
  e.kind === 'released'
    ? 'Advance released'
    : e.kind === 'repayment'
      ? 'Repaid outside payroll'
      : e.kind === 'scheduled'
        ? 'In the draft payroll'
        : 'Deducted from payroll'

/** One advance's history, oldest first: release, payroll deductions, repayments. */
export default function AdvanceLedgerList({
  entries,
  onDeleteRepayment,
  busy = false,
}: {
  entries: LedgerEntry[]
  /** Admins only: remove a repayment recorded by mistake. */
  onDeleteRepayment?: (id: string) => void
  busy?: boolean
}) {
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/80">
      {entries.map((e, i) => (
        <li key={i} className={`flex items-center gap-3 px-3 py-2.5 text-sm ${e.kind === 'scheduled' ? 'opacity-60' : ''}`}>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink-900">{title(e)}</p>
            <p className="break-words text-xs text-slate-500">
              {e.periodStart && e.periodEnd ? `${fmtPeriod(e.periodStart, e.periodEnd)} payroll · paid ${fmtDate(e.date)}` : fmtDate(e.date)}
              {e.note ? ` · ${e.note}` : ''}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className={`font-semibold ${e.amount > 0 ? 'text-ink-900' : 'text-leaf-700'}`}>
              {e.amount > 0 ? money(e.amount) : `− ${money(-e.amount)}`}
            </p>
            <p className="text-xs text-slate-500">
              {e.balance === null ? 'not final yet' : e.balance > 0 ? `${money(e.balance)} owed` : 'fully paid'}
            </p>
          </div>
          {onDeleteRepayment && (
            <span className="w-8 shrink-0">
              {e.repaymentId && (
                <IconButton size="sm" label="Delete this repayment" disabled={busy} onClick={() => onDeleteRepayment(e.repaymentId!)}>
                  <Trash2 className="size-3.5 text-rose-600" />
                </IconButton>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
