// Outputs (admins only): what an employee delivered, each accepted by an
// admin with its output report. The payroll whose period holds an output's
// date pays it, classified as the employee's output pay (Pay & Policy); a
// finalized payroll locks the outputs it paid.

import { useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Field, IconButton, Input, LoadFailed, Modal, Segmented, Select, Spinner, Textarea } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Employee, EmployeeOutput } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, money } from '../../lib/format'
import { OUTPUT_PAY_LABELS, OUTPUT_PAY_SHORT_LABELS } from '../../lib/labels'
import { todayManila } from '../../lib/manila'
import { OUTPUT_REPORT_ACCEPT, openOutputReport, outputReportPath, outputReportProblem, removeOutputReport, uploadOutputReport } from '../../lib/outputs'
import { supabase } from '../../lib/supabase'
import { round2 } from '../../payroll/types'

interface CoveringRun {
  status: 'draft' | 'finalized' | 'paid'
  period_start: string
  period_end: string
  run_type: string
}

type Status = { kind: 'paid' | 'draft' | 'open'; text: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function statusOf(o: EmployeeOutput, runs: CoveringRun[]): Status {
  const covering = runs.filter((r) => r.run_type !== 'thirteenth_month' && r.period_start <= o.output_date && o.output_date <= r.period_end)
  const period = (r: CoveringRun) => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`
  const paid = covering.find((r) => r.status !== 'draft')
  if (paid) return { kind: 'paid', text: `Paid · ${period(paid)}` }
  const draft = covering.find((r) => r.status === 'draft')
  if (draft) return { kind: 'draft', text: `In the draft payroll ${period(draft)}` }
  return { kind: 'open', text: 'Not in a payroll yet' }
}

function unitsText(o: Pick<EmployeeOutput, 'quantity' | 'unit_rate'>): string {
  if (o.quantity === null || o.unit_rate === null) return '—'
  const rate = Number(o.unit_rate).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return `${Number(o.quantity).toLocaleString('en-PH', { maximumFractionDigits: 2 })} × ₱${rate}`
}

// ---------- recording an output ----------

interface OutputForm {
  output_date: string
  description: string
  basis: 'units' | 'amount'
  quantity: string
  unit_rate: string
  amount: string
  accepted_by: string
  note: string
  file: File | null
  removeReport: boolean
}

function OutputModal({
  open,
  onClose,
  employee,
  editing,
  locked,
  known,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  employee: Employee
  editing: EmployeeOutput | null
  /** paid in a finalized payroll: only the report, approver and note can change */
  locked: boolean
  /** earlier outputs (by lower-case description): their description and last unit rate */
  known: Map<string, { text: string; rate: number | null }>
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<OutputForm>(() => blankForm())
  function blankForm(): OutputForm {
    if (editing) {
      return {
        output_date: editing.output_date,
        description: editing.description,
        basis: editing.quantity !== null ? 'units' : 'amount',
        quantity: editing.quantity !== null ? String(editing.quantity) : '',
        unit_rate: editing.unit_rate !== null ? String(Number(editing.unit_rate)) : '',
        amount: String(editing.amount),
        accepted_by: editing.accepted_by,
        note: editing.note,
        file: null,
        removeReport: false,
      }
    }
    return { output_date: todayManila(), description: '', basis: 'units', quantity: '', unit_rate: '', amount: '', accepted_by: '', note: '', file: null, removeReport: false }
  }
  useEffect(() => {
    if (open) setF(blankForm())
    // a fresh form each time it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id])

  // as the database keeps them (units to 2 decimals, the rate to 4), so the
  // total shown is the total paid
  const quantity = round2(Number(f.quantity))
  const unitRate = Math.round(Number(f.unit_rate) * 10000) / 10000
  const total = f.basis === 'units' ? (quantity > 0 && unitRate > 0 ? round2(quantity * unitRate) : 0) : Number(f.amount)
  const hasReport = !!editing?.report_path && !f.removeReport

  function describe(description: string) {
    // an output delivered before: its last rate
    const rate = known.get(description.trim().toLowerCase())?.rate
    setF((cur) => ({
      ...cur,
      description,
      ...(rate && !cur.unit_rate && !editing ? { basis: 'units' as const, unit_rate: String(rate) } : {}),
    }))
  }

  async function save() {
    if (!locked) {
      if (!f.output_date) return toast('error', 'Enter the date the output was accepted.')
      if (f.output_date > todayManila()) return toast('error', "An output is recorded once accepted: its date can't be in the future.")
      if (f.output_date < employee.hire_date) return toast('error', `The date is before the hire date (${fmtDate(employee.hire_date)}).`)
      if (!f.description.trim()) return toast('error', 'Describe the output.')
      if (f.basis === 'units' && !(quantity > 0 && unitRate > 0)) return toast('error', 'Enter the number of units and the rate per unit.')
      if (!(total > 0)) return toast('error', 'Enter the amount.')
    }
    if (f.file) {
      const problem = outputReportProblem(f.file)
      if (problem) return toast('error', problem)
    }
    setBusy(true)
    let uploaded: string | null = null
    try {
      if (f.file) {
        uploaded = outputReportPath(employee.entity_id, employee.id, f.file.name)
        await uploadOutputReport(uploaded, f.file)
      }
      const row = {
        ...(locked
          ? {}
          : {
              output_date: f.output_date,
              description: f.description.trim(),
              quantity: f.basis === 'units' ? quantity : null,
              unit_rate: f.basis === 'units' ? unitRate : null,
              amount: total,
            }),
        accepted_by: f.accepted_by.trim(),
        note: f.note.trim(),
        ...(uploaded && f.file
          ? { report_path: uploaded, report_name: f.file.name.slice(-200) }
          : f.removeReport
            ? { report_path: null, report_name: null }
            : {}),
      }
      const { error } = editing
        ? await supabase.from('employee_outputs').update(row).eq('id', editing.id)
        : await supabase.from('employee_outputs').insert({ ...row, employee_id: employee.id })
      if (error) throw error
      // the report it replaced or no longer has
      if (editing?.report_path && (uploaded || f.removeReport)) await removeOutputReport(editing.report_path)
      toast('success', editing ? 'Output updated (audit-logged).' : 'Output recorded: the payroll covering its date pays it.')
      onClose()
      onSaved()
    } catch (err) {
      if (uploaded) await removeOutputReport(uploaded)
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit output' : 'Record an output'}>
      <div className="space-y-4">
        {locked && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Paid in a finalized payroll: only its report, who accepted it and the note can change. Reopen that payroll to change the output.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accepted on" hint="The payroll covering this date pays it">
            <Input type="date" min={employee.hire_date} max={todayManila()} disabled={locked} value={f.output_date} onChange={(e) => setF({ ...f, output_date: e.target.value })} />
          </Field>
          <Field label="Accepted by (optional)" hint="Who signed it off, e.g. the client's project lead">
            <Input maxLength={120} value={f.accepted_by} onChange={(e) => setF({ ...f, accepted_by: e.target.value })} />
          </Field>
          <Field label="Output" className="sm:col-span-2">
            <Input
              list="known-outputs"
              maxLength={200}
              disabled={locked}
              placeholder="e.g. Article, Sewn shirts, Market study"
              value={f.description}
              onChange={(e) => describe(e.target.value)}
            />
            <datalist id="known-outputs">
              {[...known.entries()].map(([k, v]) => (
                <option key={k} value={v.text} />
              ))}
            </datalist>
          </Field>
          <Field label="Paid as" group className="sm:col-span-2">
            <Segmented
              label="Paid as"
              value={f.basis}
              onChange={(basis) => !locked && setF({ ...f, basis })}
              options={[
                { key: 'units', label: 'Units × rate' },
                { key: 'amount', label: 'Fixed amount' },
              ]}
            />
          </Field>
          {f.basis === 'units' ? (
            <>
              <Field label="Units">
                <Input type="number" min={0} step="0.01" disabled={locked} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
              </Field>
              <Field label="Rate per unit (PHP)">
                <Input type="number" min={0} step="0.0001" disabled={locked} value={f.unit_rate} onChange={(e) => setF({ ...f, unit_rate: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="Amount (PHP)" hint="A deliverable or milestone">
              <Input type="number" min={0} step="0.01" disabled={locked} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Output report" group hint="The accomplishment report or sign-off: PDF, image, Word, Excel or CSV, up to 10 MB">
          {hasReport && !f.file && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 font-semibold text-brand-700 hover:underline"
                onClick={() => openOutputReport(editing!).catch((err) => toast('error', errorMessage(err, 'Could not open the report')))}
              >
                <FileText className="size-4" /> {editing?.report_name}
              </button>
              <Button size="sm" variant="secondary" onClick={() => setF({ ...f, removeReport: true })}>
                Remove
              </Button>
            </div>
          )}
          <input
            type="file"
            aria-label={hasReport ? 'Replace the output report' : 'Attach the output report'}
            accept={OUTPUT_REPORT_ACCEPT}
            onChange={(e) => setF({ ...f, file: e.target.files?.[0] ?? null })}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-ink-900 hover:file:bg-slate-200"
          />
        </Field>
        <Field label="Note (optional)">
          <Textarea rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {!locked && total > 0 && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Pays <span className="font-semibold text-ink-900">{money(total)}</span>
            {f.basis === 'units' && ` (${unitsText({ quantity, unit_rate: unitRate })})`} as{' '}
            {employee.output_pay ? OUTPUT_PAY_SHORT_LABELS[employee.output_pay] : 'output pay'}.
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Record output'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the list ----------

export function OutputsTab({ employee }: { employee: Employee }) {
  const toast = useToast()
  const [data, setData] = useState<{ outputs: EmployeeOutput[]; runs: CoveringRun[] } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [month, setMonth] = useState('')
  const [modal, setModal] = useState<{ editing: EmployeeOutput | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchAll<EmployeeOutput>((from, to) =>
        supabase.from('employee_outputs').select('*').eq('employee_id', employee.id).order('output_date', { ascending: false }).order('id').range(from, to),
      ),
      fetchAll<{ payroll_runs: CoveringRun | null }>((from, to) =>
        supabase
          .from('payslips')
          .select('payroll_runs!inner(status, period_start, period_end, run_type)')
          .eq('entity_id', employee.entity_id)
          .eq('employee_id', employee.id)
          .neq('run_type', 'thirteenth_month')
          .order('id')
          .range(from, to),
      ),
    ])
      .then(([outputs, slips]) => {
        if (!cancelled) setData({ outputs, runs: slips.flatMap((s) => (s.payroll_runs ? [s.payroll_runs] : [])) })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, 'Failed to load'))
      })
    return () => {
      cancelled = true
    }
  }, [employee.id, employee.entity_id, reload])

  const rows = useMemo(
    () => (data?.outputs ?? []).map((o) => ({ o, status: statusOf(o, data?.runs ?? []) })),
    [data],
  )
  const months = useMemo(() => [...new Set(rows.map((r) => r.o.output_date.slice(0, 7)))].sort().reverse(), [rows])
  const shown = month ? rows.filter((r) => r.o.output_date.startsWith(month)) : rows
  const known = useMemo(() => {
    // newest first: the first rate seen for a description is its last
    const m = new Map<string, { text: string; rate: number | null }>()
    for (const { o } of rows) {
      const k = o.description.trim().toLowerCase()
      if (!m.has(k)) m.set(k, { text: o.description.trim(), rate: o.unit_rate !== null ? Number(o.unit_rate) : null })
    }
    return m
  }, [rows])

  if (loadError) {
    return (
      <LoadFailed
        message={loadError}
        onRetry={() => {
          setLoadError('')
          setReload((n) => n + 1)
        }}
      />
    )
  }
  if (!data) return <Spinner />

  const unpaid = rows.filter((r) => r.status.kind !== 'paid')
  const unpaidTotal = round2(unpaid.reduce((s, r) => s + Number(r.o.amount), 0))
  const noReport = rows.filter((r) => !r.o.report_path).length
  const shownTotal = round2(shown.reduce((s, r) => s + Number(r.o.amount), 0))
  const editingStatus = modal?.editing ? statusOf(modal.editing, data.runs) : null

  async function remove(o: EmployeeOutput) {
    if (!confirm(`Remove the output "${o.description}" of ${fmtDate(o.output_date)} (${money(Number(o.amount))})?`)) return
    const { error } = await supabase.from('employee_outputs').delete().eq('id', o.id)
    if (error) {
      toast('error', errorMessage(error, 'Remove failed'))
      return
    }
    await removeOutputReport(o.report_path)
    toast('success', 'Output removed.')
    setReload((n) => n + 1)
  }

  return (
    <div className="space-y-6">
      <Card
        title="Outputs"
        icon={<ClipboardCheck />}
        actions={
          employee.output_pay && (
            <Button size="sm" onClick={() => setModal({ editing: null })}>
              <Plus className="size-4" /> Record an output
            </Button>
          )
        }
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Paid as</dt>
              <dd className="font-semibold text-ink-900">
                {employee.output_pay ? OUTPUT_PAY_LABELS[employee.output_pay] : 'Output pay is off (Pay & Policy)'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Not paid yet</dt>
              <dd className="font-semibold text-ink-900">
                {money(unpaidTotal)} <span className="font-normal text-slate-500">({unpaid.length} output{unpaid.length === 1 ? '' : 's'})</span>
              </dd>
            </div>
            {noReport > 0 && (
              <div>
                <dt className="text-xs text-slate-500">Without a report</dt>
                <dd className="font-semibold text-amber-700">{noReport}</dd>
              </div>
            )}
          </dl>
          {months.length > 1 && (
            <Select aria-label="Month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {MONTHS[Number(m.slice(5, 7)) - 1]} {m.slice(0, 4)}
                </option>
              ))}
            </Select>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-slate-400">
            {employee.output_pay
              ? 'No output recorded yet. Record each output once accepted, with its report: the payroll covering its date pays it.'
              : 'Turn on output pay on the Pay & Policy tab to record outputs.'}
          </p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-4 font-semibold">Accepted</th>
                  <th className="py-1.5 pr-4 font-semibold">Output</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Units</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Amount</th>
                  <th className="py-1.5 pr-4 font-semibold">Report</th>
                  <th className="py-1.5 pr-4 font-semibold">Payroll</th>
                  <th className="py-1.5 font-semibold"> </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map(({ o, status }) => (
                  <tr key={o.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-4 text-slate-700">{fmtDate(o.output_date)}</td>
                    <td className="py-2 pr-4 text-ink-900">
                      {o.description}
                      {o.accepted_by && <p className="text-xs text-slate-500">Accepted by {o.accepted_by}</p>}
                      {o.note && <p className="text-xs text-slate-500">{o.note}</p>}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-600">{unitsText(o)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-ink-900">{money(Number(o.amount))}</td>
                    <td className="py-2 pr-4">
                      {o.report_path ? (
                        <button
                          type="button"
                          className="inline-flex max-w-48 items-center gap-1.5 text-left font-semibold text-brand-700 hover:underline"
                          onClick={() => openOutputReport(o).catch((err) => toast('error', errorMessage(err, 'Could not open the report')))}
                        >
                          <FileText className="size-4 shrink-0" />
                          <span className="truncate">{o.report_name}</span>
                        </button>
                      ) : (
                        <Badge tone="amber">No report</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={status.kind === 'paid' ? 'slate' : status.kind === 'draft' ? 'blue' : 'green'}>{status.text}</Badge>
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      <IconButton label={`Edit the output of ${fmtDate(o.output_date)}`} onClick={() => setModal({ editing: o })}>
                        <Pencil className="size-4" />
                      </IconButton>
                      {status.kind !== 'paid' && (
                        <IconButton label={`Remove the output of ${fmtDate(o.output_date)}`} onClick={() => remove(o)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {shown.length > 1 && (
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td colSpan={3} className="py-2 pr-4 text-right text-xs font-semibold text-slate-500">
                      Total
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right font-semibold tabular-nums text-ink-900">{money(shownTotal)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>

      <OutputModal
        open={modal !== null}
        onClose={() => setModal(null)}
        employee={employee}
        editing={modal?.editing ?? null}
        locked={editingStatus?.kind === 'paid'}
        known={known}
        onSaved={() => setReload((n) => n + 1)}
      />
    </div>
  )
}
