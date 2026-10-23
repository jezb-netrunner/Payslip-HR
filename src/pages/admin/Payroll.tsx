import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, CalendarCheck, CalendarRange, Plus, Search, Tags } from 'lucide-react'
import { runLabel } from '../../components/PayslipView'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadFailed,
  Modal,
  NoClient,
  PageHeader,
  Select,
  Spinner,
  StatusCounts,
  TableShell,
  Td,
  Th,
  Toggle,
} from '../../components/ui'
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
import { fetchAll } from '../../lib/fetchAll'
import { useQuickAction } from '../../lib/quickAction'

export default function Payroll() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <RunList key={entity.id} entity={entity} />
}

const STATUS_LOOK: Record<PayrollRun['status'], { tone: string; label: string; dot: string }> = {
  draft: { tone: 'amber', label: 'Draft', dot: 'bg-amber-400' },
  finalized: { tone: 'green', label: 'Finalized', dot: 'bg-leaf-500' },
  paid: { tone: 'blue', label: 'Paid', dot: 'bg-work' },
}

function RunList({ entity }: { entity: Entity }) {
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [frequency, setFrequency] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState('')
  const navigate = useNavigate()

  // wait for the runs: the new-run form suggests the period after the latest one
  useQuickAction('run', () => setCreating(true), !loading && !loadError)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      // every run: the status counts and the search cover the client's whole history
      setRuns(
        await fetchAll<PayrollRun>((from, to) =>
          supabase
            .from('payroll_runs')
            .select('*')
            .eq('entity_id', entity.id)
            .order('period_start', { ascending: false })
            .order('id')
            .range(from, to),
        ),
      )
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the payroll runs'))
    } finally {
      setLoading(false)
    }
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  const q = query.trim().toLowerCase()
  const shown = runs.filter(
    (r) =>
      (!frequency || r.pay_frequency === frequency || (frequency === 'thirteenth' && r.run_type === 'thirteenth_month')) &&
      (!status || r.status === status) &&
      (!q || `${runLabel(r)} ${fmtDate(r.pay_date)} ${fmtMonth(r.period_month)}`.toLowerCase().includes(q)),
  )
  const counts = (Object.keys(STATUS_LOOK) as PayrollRun['status'][])
    .map((k) => ({ label: STATUS_LOOK[k].label, dot: STATUS_LOOK[k].dot, count: runs.filter((r) => r.status === k).length }))
    .filter((c) => c.count > 0)

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle={
          counts.length ? (
            <StatusCounts items={counts} />
          ) : (
            'Each run covers the employees of one pay frequency. Draft → review → finalize.'
          )
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New pay run
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search pay runs" placeholder="Search pay runs" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
        <FilterPill icon={<CalendarRange className="size-4" />} label="Pay frequency" value={frequency} onChange={setFrequency}>
          <option value="">All frequencies</option>
          {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
          <option value="thirteenth">13th month</option>
        </FilterPill>
        <FilterPill icon={<Activity className="size-4" />} label="Status" value={status} onChange={setStatus}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LOOK).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </FilterPill>
      </div>

      {loadError ? (
        <LoadFailed message={loadError} onRetry={load} />
      ) : loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            title={runs.length ? 'No pay runs match' : 'No payroll runs yet'}
            sub={runs.length ? 'Try another search or filter.' : 'Create a run to compute payslips from time in/out, rates and the statutory tables.'}
          />
        </Card>
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th><span className="flex items-center gap-1.5"><CalendarRange className="size-3.5" /> Pay run</span></Th>
              <Th><span className="flex items-center gap-1.5"><Tags className="size-3.5" /> Payroll type</span></Th>
              <Th><span className="flex items-center gap-1.5"><CalendarCheck className="size-3.5" /> Pay date</span></Th>
              <Th className="text-right">Employees</Th>
              <Th className="text-right">Gross</Th>
              <Th className="text-right">Tax withheld</Th>
              <Th className="text-right">Net pay</Th>
              <Th>Status</Th>
              <Th className="text-right">Action</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const computed = typeof r.totals?.employees === 'number'
              const open = () => navigate(`/admin/payroll/${r.id}`)
              return (
                <tr key={r.id} className="cursor-pointer" onClick={open}>
                  <Td>
                    <p className="font-semibold text-ink-900">{runLabel(r)}</p>
                    <p className="text-xs text-slate-400">
                      {fmtMonth(r.period_month)}
                      {r.periods_in_month > 1 ? ` · payroll ${r.period_index} of ${r.periods_in_month}` : ''}
                    </p>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{RUN_TYPE_LABELS[r.run_type]}</span>
                      {r.pay_frequency && <Badge tone="slate" dot={false}>{FREQUENCY_LABELS[r.pay_frequency]}</Badge>}
                      {r.annualize && <Badge tone="violet" dot={false}>annualized</Badge>}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{fmtDate(r.pay_date)}</Td>
                  <Td className="text-right">{computed ? r.totals.employees : '—'}</Td>
                  <Td className="whitespace-nowrap text-right">{computed ? money(r.totals.gross ?? 0) : '—'}</Td>
                  <Td className="whitespace-nowrap text-right">{computed ? money(r.totals.withholding_tax ?? 0) : '—'}</Td>
                  <Td className="whitespace-nowrap text-right font-bold text-ink-900">
                    {computed ? money(r.totals.net ?? 0) : <span className="text-xs font-medium text-slate-400">not computed</span>}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_LOOK[r.status].tone}>{STATUS_LOOK[r.status].label}</Badge>
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant={r.status === 'draft' ? 'dark' : 'secondary'}
                      size="sm"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        open()
                      }}
                    >
                      {r.status === 'draft' ? 'Run payroll' : 'View'}
                    </Button>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableShell>
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

/** A compact grey filter control: icon, caption for screen readers, native select. */
function FilterPill({
  icon,
  label,
  value,
  onChange,
  children,
}: {
  icon: React.ReactNode
  label: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg bg-slate-200/60 py-1 pl-3 pr-1 text-sm font-medium text-ink-900">
      <span className="text-slate-500">{icon}</span>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border-0 bg-white py-1 pl-2 pr-7 text-sm font-medium text-ink-900 shadow-xs focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        {children}
      </select>
    </label>
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
        <div className="grid gap-3 sm:grid-cols-3">
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
