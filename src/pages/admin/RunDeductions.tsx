// The recurring deductions a draft payroll takes — cash advances, loans,
// anything with an installment — and the amount set for this payroll only
// where it differs from the usual one: small businesses agree on what each
// cutoff repays of an advance. 0 skips it this payroll. The next payroll
// goes back to the usual installment (none, for an advance without one).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { HandCoins, Pencil } from 'lucide-react'
import { Badge, Button, Card, Field, IconButton, Input, LoadFailed, Modal, Spinner } from '../../components/ui'
import { useToast } from '../../components/toast'
import { DEDUCTION_CATEGORY_LABELS } from '../../lib/advances'
import type { Employee, Payslip, PayrollDeductionOverride, PayrollRun, RecurringDeduction } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, fullName, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { round2 } from '../../payroll/types'

const categoryLabel = (c: string) => (c === 'cash_advance' ? 'Cash advance' : (DEDUCTION_CATEGORY_LABELS[c] ?? c.replaceAll('_', ' ')))

interface Row {
  deduction: RecurringDeduction
  employee: Employee
  set?: PayrollDeductionOverride
  /** what the last computation deducted */
  computed?: number
}

export function RunDeductionsCard({
  run,
  covered,
  slips,
  onChanged,
}: {
  run: PayrollRun
  /** the employees the run covers */
  covered: Employee[]
  slips: Payslip[]
  onChanged: () => Promise<void>
}) {
  const [deductions, setDeductions] = useState<RecurringDeduction[] | null>(null)
  const [overrides, setOverrides] = useState<PayrollDeductionOverride[]>([])
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<Row | null>(null)
  const isDraft = run.status === 'draft'

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [ds, os] = await Promise.all([
        fetchAll<RecurringDeduction>((f, t) =>
          supabase
            .from('recurring_deductions')
            .select('*, employees!inner(entity_id)')
            .eq('employees.entity_id', run.entity_id)
            .order('created_at')
            .order('id')
            .range(f, t),
        ),
        fetchAll<PayrollDeductionOverride>((f, t) =>
          supabase.from('payroll_deduction_overrides').select('*').eq('payroll_run_id', run.id).order('id').range(f, t),
        ),
      ])
      setDeductions(ds)
      setOverrides(os)
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the deductions'))
    }
  }, [run.entity_id, run.id])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => {
    if (!deductions) return []
    const byEmployee = new Map(covered.map((e) => [e.id, e]))
    const setFor = new Map(overrides.map((o) => [o.deduction_id, o]))
    const slipOf = new Map(slips.map((s) => [s.employee_id, s]))
    const out: Row[] = []
    for (const d of deductions) {
      const employee = byEmployee.get(d.employee_id)
      if (!employee) continue
      // a final pay after the last day takes only what is left of advances
      const extrasOnly = run.run_type === 'final_pay' && !!employee.separation_date && employee.separation_date < run.period_start
      if (extrasOnly && d.category !== 'cash_advance') continue
      const set = setFor.get(d.id)
      // an advance released after this payroll's pay date did not exist for it
      if (!set && d.category === 'cash_advance' && d.released_on && d.released_on > run.pay_date) continue
      const owed = d.balance !== null && d.balance !== undefined ? Number(d.balance) > 0 : true
      const inPeriod = (!d.start_date || d.start_date <= run.period_end) && (!d.end_date || d.end_date >= run.period_start)
      // what this payroll takes or could take: an advance or loan still owed
      // (even paused), any other deduction in force, and whatever is set here
      const shown = set || (owed && (d.balance !== null && d.balance !== undefined ? true : d.active && inPeriod))
      if (!shown) continue
      const line = slipOf.get(d.employee_id)?.deductions?.filter((l) => l.meta === d.id)
      out.push({
        deduction: d,
        employee,
        set,
        computed: line && line.length ? round2(line.reduce((s, l) => s + Number(l.amount), 0)) : slipOf.has(d.employee_id) ? 0 : undefined,
      })
    }
    return out.sort((a, b) => fullName(a.employee).localeCompare(fullName(b.employee)) || a.deduction.label.localeCompare(b.deduction.label))
  }, [deductions, overrides, covered, slips, run.period_start, run.period_end, run.run_type, run.pay_date])

  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!deductions) return <Spinner />
  if (rows.length === 0 && !isDraft) return null

  const setCount = rows.filter((r) => r.set).length
  return (
    <Card title={`Cash advances & loans this payroll (${rows.length})`} icon={<HandCoins />}>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No cash advances, loans or recurring deductions for the employees in this run.{' '}
          <Link to="/admin/advances" className="font-semibold text-brand-700 hover:underline">Cash Advances</Link>
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500">
            Each payroll deducts the usual installment unless an amount is set for it here — e.g. what you agreed with the
            employee for this cutoff, or ₱0 to skip it. The next payroll goes back to the usual installment.
            {setCount > 0 && isDraft && ' Recompute after changes.'}
          </p>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <DeductionRow key={r.deduction.id} row={r} run={run} onEdit={isDraft ? () => setEditing(r) : undefined} />
            ))}
          </ul>
        </>
      )}
      {editing && (
        <SetAmountModal
          row={editing}
          run={run}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await Promise.all([load(), onChanged()])
          }}
        />
      )}
    </Card>
  )
}

function usualText(d: RecurringDeduction) {
  const per = Number(d.amount_per_period)
  return per > 0 ? `${money(per)} per payroll` : 'no fixed installment'
}

function DeductionRow({ row: r, run, onEdit }: { row: Row; run: PayrollRun; onEdit?: () => void }) {
  const d = r.deduction
  const balance = d.balance !== null && d.balance !== undefined ? Number(d.balance) : null
  const notYet = !!d.start_date && d.start_date > run.period_end
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-sm font-semibold text-ink-900">{fullName(r.employee)}</p>
        <p className="break-words text-xs text-slate-500">
          {/* "Cash advance (Aug 3, 2026)" already says what it is */}
          {d.label.toLowerCase().startsWith(categoryLabel(d.category).toLowerCase()) ? d.label : `${d.label} · ${categoryLabel(d.category)}`} · usually{' '}
          {usualText(d)}
          {balance !== null && ` · ${money(balance)} owed`}
        </p>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {!d.active && <Badge tone="amber">paused</Badge>}
          {notYet && <Badge tone="violet">starts {fmtDate(d.start_date)}</Badge>}
        </div>
      </div>
      <div className="text-right">
        {r.set ? (
          <>
            <p className="text-sm font-bold text-ink-900">{Number(r.set.amount) > 0 ? money(Number(r.set.amount)) : 'Skipped'}</p>
            <p className="max-w-56 truncate text-[11px] text-brand-700" title={r.set.note || undefined}>
              set for this payroll{r.set.note ? ` · ${r.set.note}` : ''}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-ink-900">{r.computed !== undefined ? money(r.computed) : '—'}</p>
            <p className="text-[11px] text-slate-400">{r.computed !== undefined ? 'as computed' : 'not computed yet'}</p>
          </>
        )}
        {r.set && r.computed !== undefined && round2(Number(r.set.amount)) !== r.computed && (
          <p className="text-[11px] text-amber-700">last computed {money(r.computed)}</p>
        )}
      </div>
      {onEdit && (
        <IconButton size="sm" label={`Set ${d.label} for ${fullName(r.employee)} this payroll`} onClick={onEdit}>
          <Pencil className="size-4" />
        </IconButton>
      )}
    </li>
  )
}

function SetAmountModal({
  row: r,
  run,
  onClose,
  onSaved,
}: {
  row: Row
  run: PayrollRun
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const d = r.deduction
  const balance = d.balance !== null && d.balance !== undefined ? Number(d.balance) : null
  const per = Number(d.amount_per_period)
  const [amount, setAmount] = useState(r.set ? String(Number(r.set.amount)) : per > 0 ? String(balance !== null ? Math.min(per, balance) : per) : '')
  const [note, setNote] = useState(r.set?.note ?? '')
  const [busy, setBusy] = useState(false)
  const value = round2(Number(amount))
  const settles = !!r.employee.separation_date && r.employee.separation_date <= run.period_end
  const problem =
    amount.trim() === '' || !Number.isFinite(Number(amount)) || value < 0
      ? 'Enter the amount to deduct this payroll (0 to skip it).'
      : balance !== null && value > balance
        ? `Only ${money(balance)} is owed.`
        : ''

  async function save() {
    if (busy || problem) return
    setBusy(true)
    try {
      const { error } = await supabase.from('payroll_deduction_overrides').upsert(
        {
          payroll_run_id: run.id,
          deduction_id: d.id,
          employee_id: d.employee_id,
          entity_id: run.entity_id,
          amount: value,
          note: note.trim(),
        },
        { onConflict: 'payroll_run_id,deduction_id' },
      )
      if (error) throw error
      toast('success', `${value > 0 ? `${money(value)} set` : 'Skipped'} for this payroll (audit-logged). Recompute the draft.`)
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not save the amount'))
    } finally {
      setBusy(false)
    }
  }

  async function backToUsual() {
    if (busy || !r.set) return
    setBusy(true)
    try {
      const { error } = await supabase.from('payroll_deduction_overrides').delete().eq('id', r.set.id)
      if (error) throw error
      toast('success', 'Back to the usual installment. Recompute the draft.')
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not change the amount'))
    } finally {
      setBusy(false)
    }
  }

  const quick = (label: string, v: number) => (
    <button
      type="button"
      onClick={() => setAmount(String(v))}
      className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
    >
      {label}
    </button>
  )

  return (
    <Modal open onClose={onClose} title={`${d.label} · ${fullName(r.employee)}`}>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Usually</dt>
            <dd className="font-semibold text-ink-900">{usualText(d)}{!d.active && ' (paused)'}</dd>
          </div>
          {balance !== null && (
            <div>
              <dt className="text-xs text-slate-500">Owed now</dt>
              <dd className="font-semibold text-ink-900">{money(balance)}</dd>
            </div>
          )}
        </dl>
        {settles && d.category === 'cash_advance' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This payroll settles the employee's separation: without an amount set here it deducts the whole balance.
          </p>
        )}
        <Field label="Deduct this payroll (PHP)" hint="0 = skip it this payroll. Never more than the net pay allows: what it can't deduct stays owed.">
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="-mt-2 flex flex-wrap gap-2">
          {per > 0 && quick(`Usual ${money(balance !== null ? Math.min(per, balance) : per)}`, balance !== null ? Math.min(per, balance) : per)}
          {balance !== null && balance > 0 && quick(`Whole balance ${money(balance)}`, balance)}
          {quick('Skip (₱0)', 0)}
        </div>
        {per > 0 && value > per && !problem && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            More than the usual installment: deduct it only with the employee's agreement, and keep it in writing.
          </p>
        )}
        <Field label="Note (optional)">
          <Input value={note} maxLength={300} placeholder="e.g. agreed with the employee on Oct 24" onChange={(e) => setNote(e.target.value)} />
        </Field>
        {d.category === 'cash_advance' && (
          <p className="text-[11px] text-slate-400">
            The employee's signed authorization covers the deduction; for an advance without a fixed installment, record
            what you agreed for this cutoff in the note.
          </p>
        )}
        {problem && amount.trim() !== '' && <p className="text-xs font-semibold text-rose-600">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <Button className="flex-1" disabled={busy || !!problem} onClick={save}>
            {busy ? 'Saving…' : 'Set for this payroll'}
          </Button>
          {r.set && (
            <Button variant="secondary" disabled={busy} onClick={backToUsual}>
              Use the usual
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
