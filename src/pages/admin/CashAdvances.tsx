import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Download, FileSignature, HandCoins, Hourglass, ListChecks, Pause, Pencil, Play, Plus, Printer, Trash2, Wallet, X } from 'lucide-react'
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadFailed,
  Modal,
  NoClient,
  PageHeader,
  Select,
  Spinner,
  StatCard,
  StatGroup,
  Tabs,
  Textarea,
} from '../../components/ui'
import AdvanceLedgerList from '../../components/AdvanceLedgerList'
import { useToast } from '../../components/toast'
import { downloadCsv, getEmployees, isActiveOn } from '../../lib/api'
import {
  ADVANCE_STATUS_LABELS,
  ADVANCE_STATUS_TONES,
  advanceLedger,
  advanceStatus,
  nextInstallment,
  payrollsToRepay,
  type LedgerSlip,
} from '../../lib/advances'
import { useAuth } from '../../lib/auth'
import type { AdvanceRepayment, AdvanceRequest, Employee, Entity, Payslip, PaymentMethod, RecurringDeduction } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, fullName, money, personInitials, plural } from '../../lib/format'
import { PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { manilaDateStr, todayManila } from '../../lib/manila'
import { notifyPendingChanged } from '../../lib/pending'
import { useQuickAction } from '../../lib/quickAction'
import { supabase } from '../../lib/supabase'
import { round2 } from '../../payroll/types'
import { generateAdvanceForm } from '../../pdf/advanceForm'

type Person = Pick<Employee, 'id' | 'first_name' | 'middle_name' | 'last_name' | 'employee_no' | 'position' | 'separation_date' | 'pay_frequency'>
type Advance = RecurringDeduction & { employees: Person }
type Request = AdvanceRequest & { employees: Person }

const PERSON = 'id, first_name, middle_name, last_name, employee_no, position, separation_date, pay_frequency'

export default function CashAdvances() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <Advances key={entity.id} entity={entity} />
}

function Advances({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState(() => (params.get('tab') === 'requests' ? 'requests' : params.get('tab') === 'paid' ? 'paid' : 'outstanding'))
  const [employeeFilter, setEmployeeFilter] = useState(() => params.get('employee'))
  useEffect(() => {
    if (!params.get('tab') && !params.get('employee')) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('tab')
        next.delete('employee')
        return next
      },
      { replace: true },
    )
  }, [params, setParams])

  const [advances, setAdvances] = useState<Advance[]>([])
  const [requests, setRequests] = useState<Request[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [recording, setRecording] = useState<{ request?: Request; employeeId?: string } | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const today = todayManila()

  useQuickAction('advance', () => setRecording({ employeeId: employeeFilter ?? undefined }), !loading)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [adv, req, emps] = await Promise.all([
        fetchAll<Advance>((from, to) =>
          supabase
            .from('recurring_deductions')
            .select(`*, employees!inner(${PERSON}, entity_id)`)
            .eq('employees.entity_id', entity.id)
            .eq('category', 'cash_advance')
            .order('released_on', { ascending: false })
            .order('id')
            .range(from, to),
        ),
        supabase
          .from('advance_requests')
          .select(`*, employees(${PERSON})`)
          .eq('entity_id', entity.id)
          .order('created_at', { ascending: false })
          .limit(300),
        getEmployees(entity.id),
      ])
      if (req.error) throw req.error
      setAdvances(adv)
      setRequests((req.data ?? []) as Request[])
      setEmployees(emps)
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load cash advances'))
    } finally {
      setLoading(false)
    }
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  const shownAdvances = employeeFilter ? advances.filter((a) => a.employee_id === employeeFilter) : advances
  const outstanding = shownAdvances.filter((a) => Number(a.balance ?? 0) > 0)
  const paidOff = shownAdvances.filter((a) => Number(a.balance ?? 0) <= 0)
  const pending = requests.filter((r) => r.status === 'pending' && (!employeeFilter || r.employee_id === employeeFilter))
  const decided = requests.filter((r) => r.status !== 'pending' && (!employeeFilter || r.employee_id === employeeFilter)).slice(0, 30)
  const owedBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of advances) m.set(a.employee_id, round2((m.get(a.employee_id) ?? 0) + Number(a.balance ?? 0)))
    return m
  }, [advances])
  const filterName = employeeFilter ? employees.find((e) => e.id === employeeFilter) : undefined

  async function reject(r: Request) {
    if (busyId) return
    setBusyId(r.id)
    try {
      const { data, error } = await supabase
        .from('advance_requests')
        .update({ status: 'rejected', reviewed_at: new Date().toISOString(), review_notes: rejectNote[r.id]?.trim() || null })
        .eq('id', r.id)
        .eq('status', 'pending')
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) toast('error', 'This request is no longer pending (the employee may have cancelled it).')
      else toast('success', 'Request rejected.')
    } catch (err) {
      toast('error', errorMessage(err, 'Could not reject the request'))
    } finally {
      setBusyId(null)
      notifyPendingChanged()
      await load()
    }
  }

  function exportCsv() {
    const header = ['Employee No', 'Employee', 'Released', 'Released via', 'Amount', 'Per payroll', 'Repaid', 'Balance', 'Status', 'Authorization signed']
    const rows = shownAdvances.map((a) => [
      a.employees.employee_no,
      fullName(a.employees),
      a.released_on ?? '',
      a.release_method ? PAYMENT_METHOD_LABELS[a.release_method] : '',
      Number(a.total_amount),
      Number(a.amount_per_period),
      round2(Number(a.total_amount) - Number(a.balance)),
      Number(a.balance),
      ADVANCE_STATUS_LABELS[advanceStatus(a, today)],
      a.authorized_on ?? '',
    ])
    downloadCsv(`cash_advances_${entity.code}_${today}.csv`, [header, ...rows])
  }

  if (loading) return <Spinner />
  if (loadError) return <LoadFailed message={loadError} onRetry={load} />

  const totalOwed = round2(outstanding.reduce((s, a) => s + Number(a.balance), 0))
  const owing = new Set(outstanding.map((a) => a.employee_id)).size
  const nextDeduction = nextInstallment(outstanding.filter((a) => !a.start_date || a.start_date <= today))
  const viewed = advances.find((a) => a.id === viewing) ?? null

  return (
    <div>
      <PageHeader
        title="Cash Advances"
        subtitle="Interest-free advances repaid from the next payrolls: each finalized payroll deducts the installment, never more than the net pay, and the payroll that includes a separation takes the rest."
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv} disabled={shownAdvances.length === 0}>
              <Download className="size-4" /> CSV
            </Button>
            <Button onClick={() => setRecording({ employeeId: employeeFilter ?? undefined })}>
              <Plus className="size-4" /> Record advance
            </Button>
          </>
        }
      />

      {filterName && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          Showing <b className="text-ink-900">{fullName(filterName)}</b>
          <button type="button" onClick={() => setEmployeeFilter(null)} className="font-semibold text-brand-700 hover:underline">
            Show everyone
          </button>
        </p>
      )}

      <StatGroup className="mb-6">
        <StatCard label="Outstanding" value={money(totalOwed)} sub={`${plural(owing, 'employee')} repaying`} icon={<Wallet />} />
        <StatCard label="Collected per payroll" value={money(nextDeduction)} sub="current installments, capped at each balance" icon={<HandCoins />} />
        <StatCard label="Requests waiting" value={pending.length} sub={pending.length ? 'review under Requests' : 'none'} icon={<Hourglass />} tone={pending.length ? 'warn' : 'default'} />
      </StatGroup>

      <Tabs
        tabs={[
          { key: 'outstanding', label: 'Outstanding', icon: <Wallet /> },
          { key: 'requests', label: 'Requests', icon: <Hourglass />, count: pending.length },
          { key: 'paid', label: 'Fully paid', icon: <ListChecks /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'outstanding' &&
        (outstanding.length === 0 ? (
          <Card>
            <EmptyState title="No outstanding cash advances" sub="Record an advance when you release one, or approve an employee's request." />
          </Card>
        ) : (
          <div className="space-y-3">
            {outstanding.map((a) => (
              <AdvanceRow key={a.id} advance={a} today={today} onOpen={() => setViewing(a.id)} />
            ))}
          </div>
        ))}

      {tab === 'paid' &&
        (paidOff.length === 0 ? (
          <Card>
            <EmptyState title="No fully paid advances yet" />
          </Card>
        ) : (
          <div className="space-y-3">
            {paidOff.map((a) => (
              <AdvanceRow key={a.id} advance={a} today={today} onOpen={() => setViewing(a.id)} />
            ))}
          </div>
        ))}

      {tab === 'requests' && (
        <div className="space-y-3">
          {pending.length === 0 && (
            <Card>
              <EmptyState title="No requests waiting" sub="Employees ask for an advance from their portal; their requests land here." />
            </Card>
          )}
          {pending.map((r) => {
            const owes = owedBy.get(r.employee_id) ?? 0
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Avatar name={fullName(r.employees)} initials={personInitials(r.employees)} />
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-ink-900">
                        {fullName(r.employees)} <span className="font-normal text-slate-500">({r.employees.employee_no})</span>
                      </p>
                      <p className="mt-0.5 text-sm text-slate-700">
                        <b>{money(Number(r.amount))}</b> · {money(Number(r.per_payroll))} per payroll (
                        {plural(payrollsToRepay(Number(r.amount), Number(r.per_payroll)), 'payroll')})
                      </p>
                      {r.reason && <p className="mt-0.5 break-words text-xs text-slate-500">“{r.reason}”</p>}
                      <p className="mt-1 text-xs text-slate-500">
                        Filed {fmtDate(manilaDateStr(new Date(r.created_at)))} · {owes > 0 ? <span className="font-semibold text-amber-700">already owes {money(owes)}</span> : 'no other advance owed'}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Input
                      aria-label={`Note for ${fullName(r.employees)}`}
                      placeholder="Note (optional)"
                      value={rejectNote[r.id] ?? ''}
                      onChange={(e) => setRejectNote({ ...rejectNote, [r.id]: e.target.value })}
                      className="w-full sm:w-44"
                    />
                    <Button variant="dark" disabled={busyId !== null} onClick={() => setRecording({ request: r })}>
                      <Check className="size-4" /> Approve…
                    </Button>
                    <Button variant="secondary" disabled={busyId !== null} onClick={() => reject(r)}>
                      <X className="size-4 text-rose-600" /> Reject
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
          {decided.length > 0 && (
            <Card title="Decided recently">
              <div className="divide-y divide-slate-100">
                {decided.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="min-w-0">
                      <b className="text-ink-900">{fullName(r.employees)}</b>{' '}
                      <span className="text-slate-500">
                        {money(Number(r.amount))} · filed {fmtDate(manilaDateStr(new Date(r.created_at)))}
                        {r.review_notes ? ` · “${r.review_notes}”` : ''}
                      </span>
                    </span>
                    <Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'slate'}>{r.status}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {recording && (
        <RecordAdvanceModal
          entity={entity}
          employees={employees.filter((e) => isActiveOn(e, today))}
          request={recording.request}
          employeeId={recording.employeeId}
          onClose={() => setRecording(null)}
          onSaved={async () => {
            setRecording(null)
            notifyPendingChanged()
            await load()
          }}
        />
      )}
      {viewed && <AdvanceDetailModal advance={viewed} entity={entity} onClose={() => setViewing(null)} onChanged={load} />}
    </div>
  )
}

function AdvanceRow({ advance: a, today, onOpen }: { advance: Advance; today: string; onOpen: () => void }) {
  const total = Number(a.total_amount)
  const balance = Number(a.balance)
  const status = advanceStatus(a, today)
  const paidShare = total > 0 ? Math.min(100, Math.max(0, ((total - balance) / total) * 100)) : 0
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <Avatar name={fullName(a.employees)} initials={personInitials(a.employees)} />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink-900">{fullName(a.employees)}</p>
            <p className="truncate text-xs text-slate-500">
              {a.employees.employee_no} · released {fmtDate(a.released_on)}
              {a.release_method ? ` by ${PAYMENT_METHOD_LABELS[a.release_method].toLowerCase()}` : ''}
            </p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Amount</dt>
            <dd className="font-semibold text-ink-900">{money(total)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Per payroll</dt>
            <dd className="font-semibold text-ink-900">{money(Number(a.amount_per_period))}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Balance</dt>
            <dd className="font-bold text-ink-900">{money(balance)}</dd>
          </div>
        </dl>
        <div className="flex items-center gap-3">
          <Badge tone={ADVANCE_STATUS_TONES[status]}>
            {status === 'scheduled' ? `Starts ${fmtDate(a.start_date)}` : ADVANCE_STATUS_LABELS[status]}
          </Badge>
          <Button variant="secondary" size="sm" onClick={onOpen}>
            Details
          </Button>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${Math.round(paidShare)}% repaid`}>
        <div className="h-full rounded-full bg-leaf-500" style={{ width: `${paidShare}%` }} />
      </div>
    </div>
  )
}

// ---------- record (or approve) an advance ----------

function RecordAdvanceModal({
  entity,
  employees,
  request,
  employeeId,
  onClose,
  onSaved,
}: {
  entity: Entity
  employees: Employee[]
  request?: Request
  employeeId?: string
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const today = todayManila()
  const [f, setF] = useState({
    employeeId: request?.employee_id ?? (employees.some((e) => e.id === employeeId) ? employeeId! : ''),
    amount: request ? String(Number(request.amount)) : '',
    perPayroll: request ? String(Number(request.per_payroll)) : '',
    releasedOn: today,
    firstDeduction: today,
    method: 'cash' as PaymentMethod,
    signed: false,
    authorizedOn: today,
    notes: '',
  })
  const [busy, setBusy] = useState(false)
  const person: Person | undefined = request?.employees ?? employees.find((e) => e.id === f.employeeId)
  const amount = round2(Number(f.amount) || 0)
  const per = round2(Number(f.perPayroll) || 0)
  const payrolls = payrollsToRepay(amount, per)
  const problem = !person
    ? 'Pick the employee.'
    : amount <= 0
      ? 'Enter the amount released.'
      : per <= 0
        ? 'Enter how much to deduct per payroll.'
        : per > amount
          ? "The deduction per payroll can't be more than the advance."
          : !f.releasedOn || !f.firstDeduction
            ? 'Enter the release date and the first deduction date.'
            : f.firstDeduction < f.releasedOn
              ? "The first deduction can't come before the release."
              : !f.signed || !f.authorizedOn
                ? 'The employee must sign the agreement (authorization to deduct) first.'
                : ''

  function printForm() {
    if (!person || amount <= 0 || per <= 0) {
      toast('error', 'Fill in the employee, the amount and the deduction per payroll first.')
      return
    }
    generateAdvanceForm({
      employer: { name: entity.name, address: entity.registered_address, tin: entity.tin },
      employee: { name: fullName(person), employeeNo: person.employee_no, position: person.position },
      amount,
      perPayroll: per,
      payrolls,
      releasedOn: f.releasedOn,
      firstDeduction: f.firstDeduction,
      releaseMethod: PAYMENT_METHOD_LABELS[f.method].toLowerCase(),
    })
  }

  async function save() {
    if (problem || !person) {
      toast('error', problem)
      return
    }
    setBusy(true)
    try {
      if (request) {
        const { error } = await supabase.rpc('approve_advance_request', {
          p_request: request.id,
          p_amount: amount,
          p_per_payroll: per,
          p_released_on: f.releasedOn,
          p_first_deduction: f.firstDeduction,
          p_release_method: f.method,
          p_authorized_on: f.authorizedOn,
          p_notes: f.notes.trim(),
        })
        if (error) throw error
      } else {
        const { error } = await supabase.from('recurring_deductions').insert({
          employee_id: person.id,
          label: `Cash advance (${fmtDate(f.releasedOn)})`,
          category: 'cash_advance',
          amount_per_period: per,
          total_amount: amount,
          balance: amount,
          start_date: f.firstDeduction,
          active: true,
          released_on: f.releasedOn,
          release_method: f.method,
          authorized_on: f.authorizedOn,
          notes: f.notes.trim(),
        })
        if (error) throw error
      }
      toast('success', `Cash advance recorded: ${money(per)} comes off each payroll from the ${fmtDate(f.firstDeduction)} cutoff.`)
      onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not record the advance'))
    } finally {
      setBusy(false)
    }
  }

  const spread = (n: number) => setF({ ...f, perPayroll: amount > 0 ? String(Math.ceil(Math.round(amount * 100) / n) / 100) : f.perPayroll })

  return (
    <Modal open onClose={onClose} title={request ? 'Approve cash advance' : 'Record a cash advance'}>
      <div className="space-y-4">
        {request ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <b className="text-ink-900">{fullName(request.employees)}</b> asked for {money(Number(request.amount))} at{' '}
            {money(Number(request.per_payroll))} per payroll{request.reason ? ` — “${request.reason}”` : ''}. Adjust if you agreed on
            different terms.
          </p>
        ) : (
          <Field label="Employee">
            <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {fullName(e)} ({e.employee_no})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount released (PHP)">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <Field label="Deduct per payroll (PHP)">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.perPayroll} onChange={(e) => setF({ ...f, perPayroll: e.target.value })} />
          </Field>
        </div>
        <div className="-mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {payrolls > 0 ? <span>Repaid in about {plural(payrolls, 'payroll')}.</span> : <span>Spread over:</span>}
          {[1, 2, 3, 4, 6].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => spread(n)}
              disabled={amount <= 0}
              className="rounded-md border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {plural(n, 'payroll')}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Released on">
            <Input type="date" value={f.releasedOn} onChange={(e) => setF({ ...f, releasedOn: e.target.value, firstDeduction: f.firstDeduction < e.target.value ? e.target.value : f.firstDeduction })} />
          </Field>
          <Field label="Released via">
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })}>
              {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="First deduction" hint="Taken from the payroll whose cutoff includes this date, then every payroll until it is repaid.">
          <Input type="date" min={f.releasedOn} value={f.firstDeduction} onChange={(e) => setF({ ...f, firstDeduction: e.target.value })} />
        </Field>
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <FileSignature className="size-4 text-slate-500" /> Signed authorization
            </p>
            <Button variant="secondary" size="sm" onClick={printForm}>
              <Printer className="size-4" /> Print agreement
            </Button>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Deducting an advance from wages needs the employee's written authorization. Print the agreement, have them sign it, and
            keep it on file.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="size-4 accent-brand-700" checked={f.signed} onChange={(e) => setF({ ...f, signed: e.target.checked })} />
              Signed by the employee on
            </label>
            <Input type="date" aria-label="Date signed" value={f.authorizedOn} onChange={(e) => setF({ ...f, authorizedOn: e.target.value })} className="w-44" />
          </div>
        </div>
        <Field label="Notes (optional)">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {problem && <p className="text-xs text-slate-500">{problem}</p>}
        <Button className="w-full" disabled={busy || !!problem} onClick={save}>
          {busy ? 'Saving…' : request ? 'Approve and record' : 'Record advance'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- one advance: ledger and actions ----------

function AdvanceDetailModal({
  advance: a,
  entity,
  onClose,
  onChanged,
}: {
  advance: Advance
  entity: Entity
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const today = todayManila()
  const [slips, setSlips] = useState<LedgerSlip[] | null>(null)
  const [repayments, setRepayments] = useState<AdvanceRepayment[]>([])
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingPer, setEditingPer] = useState<string | null>(null)
  const [repay, setRepay] = useState<{ amount: string; date: string; notes: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [ps, rp] = await Promise.all([
        fetchAll<Pick<Payslip, 'payroll_run_id' | 'deductions' | 'pay_date' | 'period_start' | 'period_end'> & { payroll_runs: { status: string } | null }>(
          (from, to) =>
            supabase
              .from('payslips')
              .select('payroll_run_id, deductions, pay_date, period_start, period_end, payroll_runs(status)')
              .eq('employee_id', a.employee_id)
              .order('id')
              .range(from, to),
        ),
        supabase.from('advance_repayments').select('*').eq('advance_id', a.id).order('paid_on'),
      ])
      if (rp.error) throw rp.error
      setSlips(ps.map((p) => ({ ...p, finalized: p.payroll_runs?.status === 'finalized' || p.payroll_runs?.status === 'paid' })))
      setRepayments((rp.data ?? []) as AdvanceRepayment[])
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load this advance'))
    }
  }, [a.id, a.employee_id])

  useEffect(() => {
    load()
  }, [load])

  async function write(fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    if (busy) return
    setBusy(true)
    try {
      const { error } = await fn()
      if (error) throw error
      toast('success', ok)
      await Promise.all([load(), onChanged()])
      return true
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const ledger = slips ? advanceLedger(a, slips, repayments) : null
  const status = advanceStatus(a, today)
  const balance = Number(a.balance)
  const untouched = ledger && ledger.paid === 0 && repayments.length === 0 && !ledger.entries.some((e) => e.kind === 'scheduled')

  return (
    <Modal open onClose={onClose} title={`Cash advance · ${fullName(a.employees)}`} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">Released</dt>
              <dd className="font-semibold text-ink-900">
                {fmtDate(a.released_on)}
                {a.release_method && <span className="block text-xs font-normal text-slate-500">{PAYMENT_METHOD_LABELS[a.release_method]}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Amount</dt>
              <dd className="font-semibold text-ink-900">{money(Number(a.total_amount))}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Per payroll</dt>
              <dd className="font-semibold text-ink-900">
                {editingPer === null ? (
                  <span className="flex items-center gap-1.5">
                    {money(Number(a.amount_per_period))}
                    {balance > 0 && (
                      <IconButton size="sm" label="Change the deduction per payroll" onClick={() => setEditingPer(String(Number(a.amount_per_period)))}>
                        <Pencil className="size-3.5" />
                      </IconButton>
                    )}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Input type="number" min={0} step="0.01" aria-label="Deduction per payroll" value={editingPer} onChange={(e) => setEditingPer(e.target.value)} className="w-28" />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        const v = round2(Number(editingPer))
                        if (!(v > 0)) return toast('error', 'Enter an amount above zero.')
                        if (await write(() => supabase.from('recurring_deductions').update({ amount_per_period: v }).eq('id', a.id), `Now ${money(v)} per payroll.`)) setEditingPer(null)
                      }}
                    >
                      Save
                    </Button>
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Authorization signed</dt>
              <dd className="font-semibold text-ink-900">{a.authorized_on ? fmtDate(a.authorized_on) : '—'}</dd>
            </div>
          </dl>
          <div className="text-right">
            <p className="text-xs text-slate-500">Balance</p>
            <p className="text-3xl font-bold tracking-tight text-ink-900">{money(balance)}</p>
            <Badge tone={ADVANCE_STATUS_TONES[status]}>
              {status === 'scheduled' ? `First deduction ${fmtDate(a.start_date)}` : ADVANCE_STATUS_LABELS[status]}
            </Badge>
          </div>
        </div>

        {a.notes && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{a.notes}</p>}

        <div className="flex flex-wrap gap-2">
          {balance > 0 && (
            <Button variant="secondary" disabled={busy} onClick={() => setRepay({ amount: String(balance), date: today, notes: '' })}>
              <HandCoins className="size-4" /> Record repayment
            </Button>
          )}
          {balance > 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                write(
                  () => supabase.from('recurring_deductions').update({ active: !a.active }).eq('id', a.id),
                  a.active
                    ? 'Paused: payrolls skip this advance until you resume it (a final payroll will warn that it is still owed).'
                    : 'Resumed: the next payroll deducts it again.',
                )
              }
            >
              {a.active ? <Pause className="size-4" /> : <Play className="size-4" />} {a.active ? 'Pause deductions' : 'Resume deductions'}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              generateAdvanceForm({
                employer: { name: entity.name, address: entity.registered_address, tin: entity.tin },
                employee: { name: fullName(a.employees), employeeNo: a.employees.employee_no, position: a.employees.position },
                amount: Number(a.total_amount),
                perPayroll: Number(a.amount_per_period),
                payrolls: payrollsToRepay(Number(a.total_amount), Number(a.amount_per_period)),
                releasedOn: a.released_on ?? today,
                firstDeduction: a.start_date ?? a.released_on ?? today,
                releaseMethod: a.release_method ? PAYMENT_METHOD_LABELS[a.release_method].toLowerCase() : 'cash',
              })
            }
          >
            <Printer className="size-4" /> Agreement
          </Button>
          {untouched && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (!confirm('Delete this cash advance? Use this only for one recorded by mistake.')) return
                if (await write(() => supabase.from('recurring_deductions').delete().eq('id', a.id), 'Cash advance deleted.')) onClose()
              }}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
        </div>

        {repay && (
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="mb-3 text-sm font-semibold text-ink-900">Repayment outside payroll</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Amount (PHP)">
                <Input type="number" min={0} step="0.01" value={repay.amount} onChange={(e) => setRepay({ ...repay, amount: e.target.value })} />
              </Field>
              <Field label="Paid on">
                <Input type="date" value={repay.date} onChange={(e) => setRepay({ ...repay, date: e.target.value })} />
              </Field>
              <Field label="Note">
                <Input placeholder="e.g. cash, OR no." value={repay.notes} onChange={(e) => setRepay({ ...repay, notes: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={busy}
                onClick={async () => {
                  const v = round2(Number(repay.amount))
                  if (!(v > 0) || !repay.date) return toast('error', 'Enter the amount and the date paid.')
                  if (
                    await write(
                      () => supabase.from('advance_repayments').insert({ advance_id: a.id, amount: v, paid_on: repay.date, notes: repay.notes.trim() }),
                      `Repayment of ${money(v)} recorded.`,
                    )
                  )
                    setRepay(null)
                }}
              >
                Record
              </Button>
              <Button variant="ghost" onClick={() => setRepay(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {loadError ? (
          <LoadFailed message={loadError} onRetry={load} />
        ) : !ledger ? (
          <Spinner />
        ) : (
          <div>
            <AdvanceLedgerList
              entries={ledger.entries}
              busy={busy}
              onDeleteRepayment={(id) => {
                if (!confirm('Delete this repayment? The amount goes back on the balance.')) return
                write(() => supabase.from('advance_repayments').delete().eq('id', id), 'Repayment deleted.')
              }}
            />
            {ledger.unexplained !== 0 && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                The balance on record differs from this history by {money(Math.abs(ledger.unexplained))} (it was edited by hand
                before cash advances had a history).
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
