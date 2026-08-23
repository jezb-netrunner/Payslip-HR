import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, KeyRound, Plus, UserCheck, UserX } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { callAdminUsers } from '../../lib/api'
import type { CareerEvent, Employee, EmployeeAllowance, Profile, RecurringDeduction } from '../../lib/db'
import { fmtDate, fullName, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

const eventLabels: Record<string, string> = {
  hired: 'Hired',
  regularized: 'Regularized',
  promoted: 'Promoted',
  transferred: 'Transferred',
  salary_adjustment: 'Salary Adjustment',
  disciplinary: 'Disciplinary Action',
  recognition: 'Recognition',
  separated: 'Separated',
  other: 'Note',
}

export default function EmployeeDetail() {
  const { id } = useParams()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [events, setEvents] = useState<CareerEvent[]>([])
  const [allowances, setAllowances] = useState<EmployeeAllowance[]>([])
  const [deductions, setDeductions] = useState<RecurringDeduction[]>([])
  const [account, setAccount] = useState<Profile | null>(null)
  const [tab, setTab] = useState('profile')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    const [{ data: emp }, { data: evs }, { data: alw }, { data: ded }, { data: prof }] =
      await Promise.all([
        supabase.from('employees').select('*').eq('id', id).maybeSingle(),
        supabase.from('career_events').select('*').eq('employee_id', id).order('effective_date', { ascending: false }),
        supabase.from('employee_allowances').select('*').eq('employee_id', id).order('created_at'),
        supabase.from('recurring_deductions').select('*').eq('employee_id', id).order('created_at'),
        supabase.from('profiles').select('*').eq('employee_id', id).maybeSingle(),
      ])
    setEmployee((emp as Employee) ?? null)
    setEvents((evs ?? []) as CareerEvent[])
    setAllowances((alw ?? []) as EmployeeAllowance[])
    setDeductions((ded ?? []) as RecurringDeduction[])
    setAccount((prof as Profile) ?? null)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <Spinner />
  if (!employee) return <p className="text-sm text-slate-500">Employee not found.</p>

  return (
    <div>
      <Link to="/admin/employees" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
        <ArrowLeft className="size-3.5" /> All employees
      </Link>
      <PageHeader
        title={fullName(employee)}
        subtitle={`${employee.employee_no} · ${employee.position || 'No position'} · ${employee.department || 'No department'}`}
      />
      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile & HR Data' },
          { key: 'career', label: 'Career History' },
          { key: 'comp', label: 'Compensation' },
          { key: 'account', label: 'Login Account' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'profile' && <ProfileTab employee={employee} onSaved={load} />}
      {tab === 'career' && <CareerTab employee={employee} events={events} onChanged={load} />}
      {tab === 'comp' && (
        <CompTab employee={employee} allowances={allowances} deductions={deductions} onChanged={load} />
      )}
      {tab === 'account' && <AccountTab employee={employee} account={account} onChanged={load} />}
    </div>
  )
}

function ProfileTab({ employee, onSaved }: { employee: Employee; onSaved: () => Promise<void> }) {
    const toast = useToast()
    const [f, setF] = useState({ ...employee })
    const [busy, setBusy] = useState(false)
    const set = (k: keyof Employee, v: unknown) => setF({ ...f, [k]: v })

    async function save() {
      setBusy(true)
      try {
        const { error } = await supabase
          .from('employees')
          .update({
            employee_no: f.employee_no,
            first_name: f.first_name,
            middle_name: f.middle_name || null,
            last_name: f.last_name,
            suffix: f.suffix || null,
            email: f.email,
            phone: f.phone || null,
            address: f.address || null,
            birth_date: f.birth_date || null,
            gender: f.gender || null,
            civil_status: f.civil_status || null,
            tin: f.tin || null,
            sss_no: f.sss_no || null,
            philhealth_no: f.philhealth_no || null,
            pagibig_no: f.pagibig_no || null,
            hire_date: f.hire_date,
            regularization_date: f.regularization_date || null,
            separation_date: f.separation_date || null,
            employment_status: f.employment_status,
            position: f.position,
            department: f.department,
            work_schedule: f.work_schedule,
            bank_name: f.bank_name || null,
            bank_account_no: f.bank_account_no || null,
            emergency_contact_name: f.emergency_contact_name || null,
            emergency_contact_phone: f.emergency_contact_phone || null,
            notes: f.notes || null,
          })
          .eq('id', employee.id)
        if (error) throw error
        toast('success', 'Profile saved.')
        await onSaved()
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Save failed')
      } finally {
        setBusy(false)
      }
    }

    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Personal information">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><Input value={f.first_name} onChange={(e) => set('first_name', e.target.value)} /></Field>
            <Field label="Middle name"><Input value={f.middle_name ?? ''} onChange={(e) => set('middle_name', e.target.value)} /></Field>
            <Field label="Last name"><Input value={f.last_name} onChange={(e) => set('last_name', e.target.value)} /></Field>
            <Field label="Suffix"><Input value={f.suffix ?? ''} onChange={(e) => set('suffix', e.target.value)} /></Field>
            <Field label="Birth date"><Input type="date" value={f.birth_date ?? ''} onChange={(e) => set('birth_date', e.target.value)} /></Field>
            <Field label="Gender">
              <Select value={f.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
                <option value="">—</option>
                <option>Female</option>
                <option>Male</option>
                <option>Prefer not to say</option>
              </Select>
            </Field>
            <Field label="Civil status">
              <Select value={f.civil_status ?? ''} onChange={(e) => set('civil_status', e.target.value)}>
                <option value="">—</option>
                <option>Single</option>
                <option>Married</option>
                <option>Widowed</option>
                <option>Separated</option>
              </Select>
            </Field>
            <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
          </div>
          <Field label="Address" className="mt-3"><Textarea rows={2} value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Emergency contact"><Input value={f.emergency_contact_name ?? ''} onChange={(e) => set('emergency_contact_name', e.target.value)} /></Field>
            <Field label="Emergency phone"><Input value={f.emergency_contact_phone ?? ''} onChange={(e) => set('emergency_contact_phone', e.target.value)} /></Field>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Employment">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Employee no."><Input value={f.employee_no} onChange={(e) => set('employee_no', e.target.value)} /></Field>
              <Field label="Email"><Input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
              <Field label="Position"><Input value={f.position} onChange={(e) => set('position', e.target.value)} /></Field>
              <Field label="Department"><Input value={f.department} onChange={(e) => set('department', e.target.value)} /></Field>
              <Field label="Status">
                <Select value={f.employment_status} onChange={(e) => set('employment_status', e.target.value)}>
                  {Object.keys(statusOptions).map((s) => (
                    <option key={s} value={s}>{statusOptions[s]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Date hired"><Input type="date" value={f.hire_date} onChange={(e) => set('hire_date', e.target.value)} /></Field>
              <Field label="Regularization date"><Input type="date" value={f.regularization_date ?? ''} onChange={(e) => set('regularization_date', e.target.value)} /></Field>
              <Field label="Separation date"><Input type="date" value={f.separation_date ?? ''} onChange={(e) => set('separation_date', e.target.value)} /></Field>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Shift start"><Input type="time" value={f.work_schedule.start} onChange={(e) => set('work_schedule', { ...f.work_schedule, start: e.target.value })} /></Field>
              <Field label="Shift end"><Input type="time" value={f.work_schedule.end} onChange={(e) => set('work_schedule', { ...f.work_schedule, end: e.target.value })} /></Field>
              <Field label="Break (min)"><Input type="number" value={f.work_schedule.break_minutes} onChange={(e) => set('work_schedule', { ...f.work_schedule, break_minutes: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Work days" className="mt-3" hint="1=Mon … 7=Sun">
              <div className="flex gap-1.5">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => {
                  const day = i + 1
                  const on = f.work_schedule.days.includes(day)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        set('work_schedule', {
                          ...f.work_schedule,
                          days: on
                            ? f.work_schedule.days.filter((x) => x !== day)
                            : [...f.work_schedule.days, day].sort(),
                        })
                      }
                      className={`size-8 rounded-lg text-xs font-bold ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-400'}`}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </Field>
          </Card>

          <Card title="Government IDs & bank">
            <div className="grid grid-cols-2 gap-3">
              <Field label="SSS no."><Input value={f.sss_no ?? ''} onChange={(e) => set('sss_no', e.target.value)} /></Field>
              <Field label="PhilHealth no."><Input value={f.philhealth_no ?? ''} onChange={(e) => set('philhealth_no', e.target.value)} /></Field>
              <Field label="Pag-IBIG MID"><Input value={f.pagibig_no ?? ''} onChange={(e) => set('pagibig_no', e.target.value)} /></Field>
              <Field label="TIN"><Input value={f.tin ?? ''} onChange={(e) => set('tin', e.target.value)} /></Field>
              <Field label="Bank"><Input value={f.bank_name ?? ''} onChange={(e) => set('bank_name', e.target.value)} /></Field>
              <Field label="Account no."><Input value={f.bank_account_no ?? ''} onChange={(e) => set('bank_account_no', e.target.value)} /></Field>
            </div>
          </Card>

          <Button disabled={busy} onClick={save} className="w-full">
            {busy ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </div>
    )
  }

function CareerTab({
    employee,
    events,
    onChanged,
  }: {
    employee: Employee
    events: CareerEvent[]
    onChanged: () => Promise<void>
  }) {
    const toast = useToast()
    const [adding, setAdding] = useState(false)
    const [busy, setBusy] = useState(false)
    const [f, setF] = useState({
      event_type: 'promoted',
      effective_date: todayManila(),
      position: employee.position,
      department: employee.department,
      monthly_rate: '',
      daily_rate: '',
      details: '',
      apply: true,
    })

    async function save() {
      setBusy(true)
      try {
        const { error } = await supabase.from('career_events').insert({
          employee_id: employee.id,
          event_type: f.event_type,
          effective_date: f.effective_date,
          position: f.position || null,
          department: f.department || null,
          monthly_rate: f.monthly_rate ? Number(f.monthly_rate) : null,
          daily_rate: f.daily_rate ? Number(f.daily_rate) : null,
          details: f.details,
        })
        if (error) throw error
        if (f.apply) {
          const upd: Record<string, unknown> = {}
          if (f.position) upd.position = f.position
          if (f.department) upd.department = f.department
          if (f.monthly_rate) upd.monthly_rate = Number(f.monthly_rate)
          if (f.daily_rate) upd.daily_rate = Number(f.daily_rate)
          if (f.event_type === 'regularized') {
            upd.employment_status = 'regular'
            upd.regularization_date = f.effective_date
          }
          if (f.event_type === 'separated') {
            upd.employment_status = 'resigned'
            upd.separation_date = f.effective_date
          }
          if (Object.keys(upd).length > 0) {
            await supabase.from('employees').update(upd).eq('id', employee.id)
          }
        }
        toast('success', 'Career event recorded.')
        setAdding(false)
        await onChanged()
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Failed')
      } finally {
        setBusy(false)
      }
    }

    return (
      <Card
        title="Career history with the company"
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Record event
          </Button>
        }
      >
        {events.length === 0 ? (
          <p className="text-sm text-slate-400">No events recorded.</p>
        ) : (
          <ol className="relative ml-2 space-y-5 border-l-2 border-brand-100 pl-5">
            {events.map((ev) => (
              <li key={ev.id} className="relative">
                <span className="absolute -left-[27px] top-1 size-3 rounded-full border-2 border-white bg-accent-500" />
                <p className="text-xs font-semibold text-slate-400">{fmtDate(ev.effective_date)}</p>
                <p className="text-sm font-bold text-slate-800">
                  {eventLabels[ev.event_type] ?? ev.event_type}
                  {ev.position ? ` — ${ev.position}` : ''}
                </p>
                <p className="text-xs text-slate-500">
                  {[
                    ev.department,
                    ev.monthly_rate ? `${money(Number(ev.monthly_rate))}/mo` : null,
                    ev.daily_rate ? `${money(Number(ev.daily_rate))}/day` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
                {ev.details && <p className="mt-0.5 text-xs text-slate-500">{ev.details}</p>}
              </li>
            ))}
          </ol>
        )}

        <Modal open={adding} onClose={() => setAdding(false)} title="Record career event">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Event type">
                <Select value={f.event_type} onChange={(e) => setF({ ...f, event_type: e.target.value })}>
                  {Object.entries(eventLabels).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Effective date">
                <Input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} />
              </Field>
              <Field label="Position"><Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></Field>
              <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
              <Field label="New monthly rate"><Input type="number" value={f.monthly_rate} onChange={(e) => setF({ ...f, monthly_rate: e.target.value })} /></Field>
              <Field label="New daily rate"><Input type="number" value={f.daily_rate} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} /></Field>
            </div>
            <Field label="Details"><Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
            <Toggle checked={f.apply} onChange={(v) => setF({ ...f, apply: v })} label="Also update the employee's current record (position/rate/status)" />
            <Button className="w-full" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Record event'}
            </Button>
          </div>
        </Modal>
      </Card>
    )
  }

function CompTab({
    employee,
    allowances,
    deductions,
    onChanged,
  }: {
    employee: Employee
    allowances: EmployeeAllowance[]
    deductions: RecurringDeduction[]
    onChanged: () => Promise<void>
  }) {
    const toast = useToast()
    const [f, setF] = useState({
      pay_type: employee.pay_type,
      monthly_rate: String(employee.monthly_rate),
      daily_rate: String(employee.daily_rate),
      is_mwe: employee.is_minimum_wage_earner,
    })
    const [busy, setBusy] = useState(false)
    const [alwForm, setAlwForm] = useState({ label: '', amount: '', taxable: true, de_minimis: false })
    const [dedForm, setDedForm] = useState({ label: '', category: 'other', amount: '', total: '' })

    async function saveRates() {
      setBusy(true)
      try {
        const { error } = await supabase
          .from('employees')
          .update({
            pay_type: f.pay_type,
            monthly_rate: Number(f.monthly_rate) || 0,
            daily_rate: Number(f.daily_rate) || 0,
            is_minimum_wage_earner: f.is_mwe,
          })
          .eq('id', employee.id)
        if (error) throw error
        toast('success', 'Rates saved. Consider recording a salary-adjustment career event too.')
        await onChanged()
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Failed')
      } finally {
        setBusy(false)
      }
    }

    async function addAllowance() {
      if (!alwForm.label || !alwForm.amount) return
      const { error } = await supabase.from('employee_allowances').insert({
        employee_id: employee.id,
        label: alwForm.label,
        monthly_amount: Number(alwForm.amount),
        taxable: alwForm.taxable,
        de_minimis: alwForm.de_minimis,
      })
      if (error) toast('error', error.message)
      else {
        setAlwForm({ label: '', amount: '', taxable: true, de_minimis: false })
        await onChanged()
      }
    }

    async function addDeduction() {
      if (!dedForm.label || !dedForm.amount) return
      const { error } = await supabase.from('recurring_deductions').insert({
        employee_id: employee.id,
        label: dedForm.label,
        category: dedForm.category,
        amount_per_period: Number(dedForm.amount),
        total_amount: dedForm.total ? Number(dedForm.total) : null,
        balance: dedForm.total ? Number(dedForm.total) : null,
      })
      if (error) toast('error', error.message)
      else {
        setDedForm({ label: '', category: 'other', amount: '', total: '' })
        await onChanged()
      }
    }

    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Pay rates">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pay type">
              <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value as 'monthly' | 'daily' })}>
                <option value="monthly">Monthly-paid</option>
                <option value="daily">Daily-paid</option>
              </Select>
            </Field>
            {f.pay_type === 'monthly' ? (
              <Field label="Monthly rate (PHP)">
                <Input type="number" value={f.monthly_rate} onChange={(e) => setF({ ...f, monthly_rate: e.target.value })} />
              </Field>
            ) : (
              <Field label="Daily rate (PHP)">
                <Input type="number" value={f.daily_rate} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} />
              </Field>
            )}
          </div>
          <div className="mt-4">
            <Toggle
              checked={f.is_mwe}
              onChange={(v) => setF({ ...f, is_mwe: v })}
              label="Minimum wage earner (exempt from withholding tax incl. OT/ND/holiday pay)"
            />
          </div>
          <Button className="mt-4" disabled={busy} onClick={saveRates}>
            {busy ? 'Saving…' : 'Save rates'}
          </Button>
        </Card>

        <Card title="Allowances (monthly)">
          <div className="space-y-2">
            {allowances.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{a.label}</p>
                  <p className="text-xs text-slate-400">
                    {money(Number(a.monthly_amount))}/mo ·{' '}
                    {a.de_minimis ? 'de minimis (non-taxable)' : a.taxable ? 'taxable' : 'non-taxable'}
                    {!a.active && ' · inactive'}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    await supabase.from('employee_allowances').update({ active: !a.active }).eq('id', a.id)
                    await onChanged()
                  }}
                  className="text-xs font-semibold text-brand-600"
                >
                  {a.active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Input placeholder="Label (e.g. Rice subsidy)" value={alwForm.label} onChange={(e) => setAlwForm({ ...alwForm, label: e.target.value })} />
            <Input placeholder="Amount / month" type="number" value={alwForm.amount} onChange={(e) => setAlwForm({ ...alwForm, amount: e.target.value })} />
          </div>
          <div className="mt-2 flex items-center gap-4">
            <Toggle checked={alwForm.taxable} onChange={(v) => setAlwForm({ ...alwForm, taxable: v })} label="Taxable" />
            <Toggle checked={alwForm.de_minimis} onChange={(v) => setAlwForm({ ...alwForm, de_minimis: v })} label="De minimis" />
            <Button variant="secondary" onClick={addAllowance}><Plus className="size-4" /> Add</Button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            De minimis benefits within BIR ceilings (RR 29-2025 for 2026: rice ₱2,500/mo, uniform ₱8,000/yr,
            laundry ₱400/mo, etc.) are non-taxable; excesses count toward the ₱90,000 cap.
          </p>
        </Card>

        <Card title="Recurring deductions (per payroll period)" className="lg:col-span-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {deductions.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{d.label}</p>
                  <p className="text-xs text-slate-400">
                    {money(Number(d.amount_per_period))}/period · {d.category.replaceAll('_', ' ')}
                    {d.balance !== null && ` · balance ${money(Number(d.balance))}`}
                    {!d.active && ' · inactive'}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    await supabase.from('recurring_deductions').update({ active: !d.active }).eq('id', d.id)
                    await onChanged()
                  }}
                  className="text-xs font-semibold text-brand-600"
                >
                  {d.active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Input placeholder="Label (e.g. SSS salary loan)" value={dedForm.label} onChange={(e) => setDedForm({ ...dedForm, label: e.target.value })} className="lg:col-span-2" />
            <Select value={dedForm.category} onChange={(e) => setDedForm({ ...dedForm, category: e.target.value })}>
              <option value="sss_loan">SSS loan</option>
              <option value="pagibig_loan">Pag-IBIG loan</option>
              <option value="company_loan">Company loan</option>
              <option value="cash_advance">Cash advance</option>
              <option value="hmo">HMO</option>
              <option value="other">Other</option>
            </Select>
            <Input placeholder="Amount / period" type="number" value={dedForm.amount} onChange={(e) => setDedForm({ ...dedForm, amount: e.target.value })} />
            <div className="flex gap-2">
              <Input placeholder="Total (optional)" type="number" value={dedForm.total} onChange={(e) => setDedForm({ ...dedForm, total: e.target.value })} />
              <Button variant="secondary" onClick={addDeduction}><Plus className="size-4" /></Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Deductions with a total amount auto-deactivate when the remaining balance reaches zero
            (decremented every finalized payroll).
          </p>
        </Card>
      </div>
    )
  }

function AccountTab({
    employee,
    account,
    onChanged,
  }: {
    employee: Employee
    account: Profile | null
    onChanged: () => Promise<void>
  }) {
    const toast = useToast()
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)

    async function run(action: string, extra: Record<string, unknown> = {}) {
      setBusy(true)
      try {
        const res = await callAdminUsers({ action, ...extra })
        if (res.error) throw new Error(res.error)
        toast('success', 'Done.')
        setPassword('')
        await onChanged()
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'Failed')
      } finally {
        setBusy(false)
      }
    }

    return (
      <Card title="Employee login account">
        {account ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <UserCheck className="size-5 text-emerald-500" />
              <div>
                <p className="text-sm font-semibold text-slate-700">{account.email}</p>
                <p className="text-xs text-slate-400">
                  Role: {account.role} · {account.is_active ? 'active' : 'deactivated'}
                </p>
              </div>
              <Badge tone={account.is_active ? 'green' : 'red'}>
                {account.is_active ? 'Active' : 'Deactivated'}
              </Badge>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="New password (min 8 chars)">
                <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="w-56" />
              </Field>
              <Button
                variant="secondary"
                disabled={busy || password.length < 8}
                onClick={() => run('reset_password', { user_id: account.id, password })}
              >
                <KeyRound className="size-4" /> Reset password
              </Button>
              <Button
                variant={account.is_active ? 'danger' : 'primary'}
                disabled={busy}
                onClick={() => run('set_active', { user_id: account.id, active: !account.is_active })}
              >
                <UserX className="size-4" /> {account.is_active ? 'Deactivate login' : 'Reactivate login'}
              </Button>
            </div>
            <p className="text-xs text-slate-400">
              Each employee signs in with their own private account. That account — plus mandatory
              selfie, device and server-time checks — is what prevents one employee from punching
              in for another.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              No login yet. Create one so this employee can clock in/out and view payslips.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Email">
                <Input value={employee.email} disabled className="w-64" />
              </Field>
              <Field label="Temporary password (min 8 chars)">
                <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="w-56" />
              </Field>
              <Button
                disabled={busy || password.length < 8}
                onClick={() =>
                  run('create_employee_account', {
                    employee_id: employee.id,
                    email: employee.email,
                    password,
                  })
                }
              >
                {busy ? 'Creating…' : 'Create login'}
              </Button>
            </div>
            <p className="text-xs text-slate-400">
              Share the temporary password securely and ask the employee to change it after first
              sign-in (Supabase Auth handles password changes).
            </p>
          </div>
        )}
      </Card>
    )
}

const statusOptions: Record<string, string> = {
  probationary: 'Probationary',
  regular: 'Regular',
  contractual: 'Contractual',
  project_based: 'Project-based',
  part_time: 'Part-time',
  resigned: 'Resigned',
  terminated: 'Terminated',
  retired: 'Retired',
}
