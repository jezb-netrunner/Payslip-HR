import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Wallet } from 'lucide-react'
import { runLabel } from '../../components/PayslipView'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, NoClient, PageHeader, Select, Spinner, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, isActiveOn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, PayrollRun, RunType } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtMonth, fullName, money, plural } from '../../lib/format'
import { FREQUENCY_LABELS, RUN_TYPE_LABELS } from '../../lib/labels'
import { addDays, todayManila } from '../../lib/manila'
import { slotFor, suggestPeriod } from '../../lib/payPeriods'
import { supabase } from '../../lib/supabase'
import type { PayFrequency } from '../../payroll/types'
import { errorMessage } from '../../lib/errors'

export default function Payroll() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <RunList key={entity.id} entity={entity} />
}

function RunList({ entity }: { entity: Entity }) {
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [frequency, setFrequency] = useState('')
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('payroll_runs')
      .select('*')
      .eq('entity_id', entity.id)
      .order('period_start', { ascending: false })
      .limit(200)
    setRuns((data ?? []) as PayrollRun[])
    setLoading(false)
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  const shown = runs.filter((r) => !frequency || r.pay_frequency === frequency || (frequency === 'thirteenth' && r.run_type === 'thirteenth_month'))

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle={`${entity.name} · each run covers the employees of one pay frequency. Draft → review → finalize.`}
        actions={
          <>
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="w-44">
              <option value="">All runs</option>
              {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
              <option value="thirteenth">13th month</option>
            </Select>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New payroll run
            </Button>
          </>
        }
      />
      {loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title="No payroll runs yet" sub="Create a run to compute payslips from time in/out, rates and the statutory tables." />
        </Card>
      ) : (
        <div className="grid gap-3">
          {shown.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/admin/payroll/${r.id}`)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50">
                  <Wallet className="size-5 text-brand-600" />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {runLabel(r)}{' '}
                    {r.pay_frequency && <Badge tone="blue">{FREQUENCY_LABELS[r.pay_frequency]}</Badge>}{' '}
                    {r.annualize && <Badge tone="violet">annualized</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">
                    Pay date {fmtDate(r.pay_date)} · {fmtMonth(r.period_month)}
                    {r.periods_in_month > 1 ? ` payroll ${r.period_index} of ${r.periods_in_month}` : ''} ·{' '}
                    {plural(r.totals?.employees ?? 0, 'employee')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs text-slate-400">Net total</p>
                  <p className="text-base font-extrabold text-brand-900">{money(r.totals?.net ?? 0)}</p>
                </div>
                <Badge tone={r.status === 'draft' ? 'amber' : r.status === 'finalized' ? 'green' : 'blue'}>{r.status}</Badge>
              </div>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewRunModal
          entity={entity}
          runs={runs}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/admin/payroll/${id}`)}
        />
      )}
    </div>
  )
}

function NewRunModal({
  entity,
  runs,
  onClose,
  onCreated,
}: {
  entity: Entity
  runs: PayrollRun[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const toast = useToast()
  const today = todayManila()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [runType, setRunType] = useState<RunType>('regular')
  const [frequency, setFrequency] = useState<PayFrequency>(entity.default_pay_frequency)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [pay, setPay] = useState('')
  const [slot, setSlot] = useState({ month: '', index: 1, count: 1 })
  const [annualize, setAnnualize] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getEmployees(entity.id).then(setEmployees)
  }, [entity.id])

  // suggest dates whenever the type or frequency changes
  useEffect(() => {
    if (runType === 'thirteenth_month') {
      const y = today.slice(0, 4)
      setStart(`${y}-01-01`)
      setEnd(`${y}-12-31`)
      setPay(`${y}-12-24`)
      setAnnualize(false)
      return
    }
    const previous = runs.filter((r) => r.run_type === 'regular' && r.pay_frequency === frequency)
    const p = suggestPeriod(frequency, previous, today)
    setStart(p.start)
    setEnd(p.end)
    setPay(addDays(p.end, Number(entity.pay_date_lag_days)))
    setAnnualize(runType === 'final_pay')
  }, [runType, frequency, runs, today, entity.pay_date_lag_days])

  // the payroll month and slot follow the period's cutoff, not the pay date
  useEffect(() => {
    if (!end) return
    if (runType === 'thirteenth_month') setSlot({ month: `${end.slice(0, 7)}-01`, index: 1, count: 1 })
    else setSlot(slotFor(frequency, end))
  }, [end, frequency, runType])

  const eligible = useMemo(
    () =>
      employees.filter((e) => {
        if (e.hire_date > (end || today)) return false
        if (runType !== 'thirteenth_month' && e.pay_frequency !== frequency) return false
        // final pay: separated employees, also when released after the
        // period that held their last day (one-time items + tax only)
        if (runType === 'final_pay') return !!e.separation_date && e.separation_date <= (end || today)
        return !e.separation_date || e.separation_date >= (start || today)
      }),
    [employees, start, end, frequency, runType, today],
  )
  // the picker only applies to the run type showing it, and only to people eligible now
  const picked = runType === 'regular' ? [] : selected.filter((id) => eligible.some((e) => e.id === id))
  const needsSubset = runType === 'final_pay'
  const lastOfYear = pay.slice(5, 7) === '12' && runType === 'regular'

  async function create() {
    if (!start || !end || !pay || end < start) {
      toast('error', 'Check the period and pay dates.')
      return
    }
    if (needsSubset && picked.length === 0) {
      toast('error', 'Pick the separated employee(s) for this final pay.')
      return
    }
    if (runType !== 'thirteenth_month') {
      // mirrors payroll_runs_frequency_check
      const [lo, hi] = frequency === 'monthly' ? [1, 1] : frequency === 'semi_monthly' ? [2, 2] : [4, 5]
      if (!Number.isInteger(slot.count) || slot.count < lo || slot.count > hi) {
        toast('error', `${FREQUENCY_LABELS[frequency]} payroll has ${lo === hi ? plural(lo, 'payroll') : `${lo} or ${hi} payrolls`} in a month.`)
        return
      }
      if (!Number.isInteger(slot.index) || slot.index < 1 || slot.index > slot.count) {
        toast('error', `Payroll no. in month must be between 1 and ${slot.count}.`)
        return
      }
    }
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('payroll_runs')
        .insert({
          entity_id: entity.id,
          run_type: runType,
          pay_frequency: runType === 'thirteenth_month' ? null : frequency,
          period_start: start,
          period_end: end,
          pay_date: pay,
          period_month: slot.month,
          period_index: runType === 'thirteenth_month' ? 1 : slot.index,
          periods_in_month: runType === 'thirteenth_month' ? 1 : slot.count,
          annualize: runType === 'thirteenth_month' ? false : annualize,
          employee_ids: picked.length > 0 ? picked : null,
          status: 'draft',
        })
        .select('id')
        .single()
      if (error) throw error
      toast('success', 'Run created — enter any one-time adjustments, then compute the draft.')
      onCreated(data.id)
    } catch (err) {
      const msg = errorMessage(err, 'Failed to create run')
      toast(
        'error',
        /regular_slot/.test(msg)
          ? `A regular ${FREQUENCY_LABELS[frequency].toLowerCase()} run already exists for payroll ${slot.index} of ${fmtMonth(slot.month)}. Use a special run, or adjust the slot.`
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="New payroll run" wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Run type">
            <Select
              value={runType}
              onChange={(e) => {
                setRunType(e.target.value as RunType)
                setSelected([])
              }}
            >
              {Object.entries(RUN_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          {runType !== 'thirteenth_month' && (
            <Field label="Pay frequency (employees included)">
              <Select
                value={frequency}
                onChange={(e) => {
                  setFrequency(e.target.value as PayFrequency)
                  setSelected([])
                }}
              >
                {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v} ({employees.filter((x) => x.pay_frequency === k && isActiveOn(x, today)).length} active)
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Period start">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period end (cutoff)">
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Pay date">
            <Input type="date" value={pay} onChange={(e) => setPay(e.target.value)} />
          </Field>
        </div>
        {runType !== 'thirteenth_month' && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Counts as <b>payroll {slot.index} of {slot.count}</b> for <b>{fmtMonth(slot.month)}</b> — monthly rates,
            allowances and contributions are allocated accordingly.{' '}
            <button className="font-semibold text-brand-600" onClick={() => setAdvanced(!advanced)}>
              {advanced ? 'Hide' : 'Change'}
            </button>
            {advanced && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Field label="Payroll month">
                  <Input type="month" value={slot.month.slice(0, 7)} onChange={(e) => setSlot({ ...slot, month: `${e.target.value}-01` })} />
                </Field>
                <Field label="Payroll no. in month">
                  <Input type="number" min={1} max={slot.count} value={slot.index} onChange={(e) => setSlot({ ...slot, index: Number(e.target.value) })} />
                </Field>
                <Field label="Payrolls in month">
                  <Input
                    type="number"
                    min={frequency === 'weekly' ? 4 : frequency === 'semi_monthly' ? 2 : 1}
                    max={frequency === 'weekly' ? 5 : frequency === 'semi_monthly' ? 2 : 1}
                    value={slot.count}
                    onChange={(e) => setSlot({ ...slot, count: Number(e.target.value) })}
                  />
                </Field>
              </div>
            )}
          </div>
        )}
        {runType !== 'thirteenth_month' && (
          <div className="rounded-lg border border-slate-200 p-3">
            <Toggle
              checked={annualize}
              onChange={setAnnualize}
              label="Annualize withholding tax in this run (year-end / separation adjustment)"
            />
            <p className="mt-1 text-xs text-slate-500">
              Withholding becomes the year's tax due less everything already withheld (refund if negative). Use it on
              the last payroll of the year and on final pay.
              {lastOfYear && !annualize && ' This looks like a December payroll — annualize it if it is the last one of the year.'}
            </p>
          </div>
        )}
        {(runType !== 'regular') && (
          <Field
            group
            label={needsSubset ? 'Employees (required)' : 'Limit to employees (optional — default: everyone eligible)'}
          >
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-3">
              {eligible.length === 0 && <p className="text-xs text-slate-400">No eligible employees for this period.</p>}
              {eligible.map((e) => (
                <label key={e.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(e.id)}
                    onChange={(ev) => setSelected(ev.target.checked ? [...selected, e.id] : selected.filter((x) => x !== e.id))}
                    className="rounded border-slate-300"
                  />
                  {fullName(e)} <span className="text-xs text-slate-400">{e.employee_no}</span>
                  {e.separation_date && <Badge tone="red">left {fmtDate(e.separation_date)}</Badge>}
                </label>
              ))}
            </div>
          </Field>
        )}
        {runType === 'thirteenth_month' && (
          <p className="rounded-lg bg-accent-50 px-3 py-2 text-xs text-accent-800">
            13th month = 1/12 of basic salary earned in the calendar year (finalized runs, every pay frequency),
            less any installment already paid. Due not later than December 24 (PD 851). For a separated employee,
            run it for that employee with their final pay.
          </p>
        )}
        {(runType === 'special' || runType === 'final_pay') && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Special and final-pay runs compute the chosen period like a regular run (attendance, contributions,
            tax). Anyone a finalized run already paid for part of the period is left out, so days are never paid
            twice. Final pay: choose the period holding the last day if it is still unpaid — the regular run then
            leaves the employee out; if it was already paid, choose a later period and the final pay carries only
            the one-time items (SIL conversion, other benefits) and the year's tax adjustment. A regular run that
            includes a separation date also settles that employee's tax and cash-rounding balance.
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create draft run'}
        </Button>
      </div>
    </Modal>
  )
}
