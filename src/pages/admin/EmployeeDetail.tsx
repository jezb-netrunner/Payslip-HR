import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, KeyRound, Plus, Printer, RefreshCw, UserCheck, UserX } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { callAdminUsers } from '../../lib/api'
import type {
  CareerEvent,
  Employee,
  EmployeeAllowance,
  EmployeeTaxYear,
  EmploymentStatus,
  Entity,
  PaymentMethod,
  Profile,
  RecurringDeduction,
  SeparationReason,
} from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtDateTime, fullName, money } from '../../lib/format'
import {
  ALLOWANCE_BASIS_LABELS,
  ALLOWANCE_CATEGORY_LABELS,
  EMPLOYMENT_STATUS_LABELS,
  FREQUENCY_LABELS,
  PAYMENT_METHOD_LABELS,
  SEPARATION_REASON_LABELS,
} from '../../lib/labels'
import { generateCodePart } from '../../lib/loginCode'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import type { AllowanceBasis, AllowanceCategory, PayFrequency } from '../../payroll/types'
import { errorMessage } from '../../lib/errors'

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
  const { entities } = useEntity()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [events, setEvents] = useState<CareerEvent[]>([])
  const [allowances, setAllowances] = useState<EmployeeAllowance[]>([])
  const [deductions, setDeductions] = useState<RecurringDeduction[]>([])
  const [account, setAccount] = useState<Profile | null>(null)
  const [tab, setTab] = useState('profile')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    const [{ data: emp }, { data: evs }, { data: alw }, { data: ded }, { data: prof }] = await Promise.all([
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
  const entity = entities.find((e) => e.id === employee.entity_id)
  if (!entity) return <p className="text-sm text-slate-500">This employee's client is not available to you.</p>

  return (
    <div>
      <Link to="/admin/employees" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
        <ArrowLeft className="size-3.5" /> All employees
      </Link>
      <PageHeader
        title={fullName(employee)}
        subtitle={
          <>
            {employee.employee_no} · {employee.position || 'No position'} · {entity.name}
            {employee.separation_date && (
              <>
                {' '}
                <Badge tone="red">
                  separated {fmtDate(employee.separation_date)}
                  {employee.separation_reason ? ` — ${SEPARATION_REASON_LABELS[employee.separation_reason]}` : ''}
                </Badge>
              </>
            )}
          </>
        }
      />
      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile & Employment' },
          { key: 'pay', label: 'Pay & Policy' },
          { key: 'career', label: 'Career History' },
          { key: 'login', label: 'Login Code' },
          { key: 'bir', label: 'BIR / Tax Year' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'profile' && <ProfileTab employee={employee} onSaved={load} />}
      {tab === 'pay' && (
        <PayTab employee={employee} entity={entity} allowances={allowances} deductions={deductions} onChanged={load} />
      )}
      {tab === 'career' && <CareerTab employee={employee} events={events} onChanged={load} />}
      {tab === 'login' && <LoginTab employee={employee} entity={entity} account={account} onChanged={load} />}
      {tab === 'bir' && <BirTab employee={employee} />}
    </div>
  )
}

function ProfileTab({ employee, onSaved }: { employee: Employee; onSaved: () => Promise<void> }) {
  const toast = useToast()
  const [f, setF] = useState({ ...employee })
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Employee>(k: K, v: Employee[K]) => setF({ ...f, [k]: v })

  async function save() {
    if (!!f.separation_date !== !!f.separation_reason) {
      toast('error', 'A separation needs both the last day and the reason (or neither).')
      return
    }
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
          email: f.email || null,
          phone: f.phone || null,
          address: f.address || null,
          zip_code: f.zip_code || null,
          birth_date: f.birth_date || null,
          gender: f.gender || null,
          civil_status: f.civil_status || null,
          nationality: f.nationality || 'Filipino',
          tin: f.tin || null,
          sss_no: f.sss_no || null,
          philhealth_no: f.philhealth_no || null,
          pagibig_no: f.pagibig_no || null,
          hire_date: f.hire_date,
          regularization_date: f.regularization_date || null,
          separation_date: f.separation_date || null,
          separation_reason: f.separation_reason || null,
          separation_remarks: f.separation_remarks || null,
          employment_status: f.employment_status,
          position: f.position,
          department: f.department,
          work_schedule: f.work_schedule,
          emergency_contact_name: f.emergency_contact_name || null,
          emergency_contact_phone: f.emergency_contact_phone || null,
          notes: f.notes || null,
        })
        .eq('id', employee.id)
      if (error) throw error
      toast('success', 'Saved (audit-logged).')
      await onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Save failed')
      toast('error', /tin_format/.test(msg) ? 'TIN must look like 000-000-000 or 000-000-000-00000.' : msg)
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
          <Field label="Nationality"><Input value={f.nationality} onChange={(e) => set('nationality', e.target.value)} /></Field>
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
          <Field label="Email (optional)"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-3">
          <Field label="Registered address" className="col-span-3">
            <Textarea rows={2} value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label="ZIP code"><Input value={f.zip_code ?? ''} onChange={(e) => set('zip_code', e.target.value)} /></Field>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Emergency contact"><Input value={f.emergency_contact_name ?? ''} onChange={(e) => set('emergency_contact_name', e.target.value)} /></Field>
          <Field label="Emergency phone"><Input value={f.emergency_contact_phone ?? ''} onChange={(e) => set('emergency_contact_phone', e.target.value)} /></Field>
        </div>
        <h4 className="mt-5 mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Government IDs</h4>
        <div className="grid grid-cols-2 gap-3">
          <Field label="TIN" hint="Required for BIR 1604-C / alphalist"><Input value={f.tin ?? ''} placeholder="000-000-000" onChange={(e) => set('tin', e.target.value)} /></Field>
          <Field label="SSS no."><Input value={f.sss_no ?? ''} onChange={(e) => set('sss_no', e.target.value)} /></Field>
          <Field label="PhilHealth no."><Input value={f.philhealth_no ?? ''} onChange={(e) => set('philhealth_no', e.target.value)} /></Field>
          <Field label="Pag-IBIG MID"><Input value={f.pagibig_no ?? ''} onChange={(e) => set('pagibig_no', e.target.value)} /></Field>
        </div>
      </Card>

      <div className="space-y-6">
        <Card title="Employment">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Employee no."><Input value={f.employee_no} onChange={(e) => set('employee_no', e.target.value)} /></Field>
            <Field label="Employment status" hint="BIR codes R / P / C / CP / S / AL">
              <Select value={f.employment_status} onChange={(e) => set('employment_status', e.target.value as EmploymentStatus)}>
                {Object.entries(EMPLOYMENT_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Position"><Input value={f.position} onChange={(e) => set('position', e.target.value)} /></Field>
            <Field label="Department"><Input value={f.department} onChange={(e) => set('department', e.target.value)} /></Field>
            <Field label="Date started"><Input type="date" value={f.hire_date} onChange={(e) => set('hire_date', e.target.value)} /></Field>
            <Field label="Regularization date"><Input type="date" value={f.regularization_date ?? ''} onChange={(e) => set('regularization_date', e.target.value)} /></Field>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Shift start"><Input type="time" value={f.work_schedule.start} onChange={(e) => set('work_schedule', { ...f.work_schedule, start: e.target.value })} /></Field>
            <Field label="Shift end"><Input type="time" value={f.work_schedule.end} onChange={(e) => set('work_schedule', { ...f.work_schedule, end: e.target.value })} /></Field>
            <Field label="Break (min)"><Input type="number" value={f.work_schedule.break_minutes} onChange={(e) => set('work_schedule', { ...f.work_schedule, break_minutes: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Work days" className="mt-3">
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

        <Card title="Separation (resignation, termination, retirement…)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Last day of employment">
              <Input type="date" value={f.separation_date ?? ''} onChange={(e) => set('separation_date', e.target.value)} />
            </Field>
            <Field label="Reason" hint="BIR codes: T resigned/terminated, TR transferred, R retired, D death">
              <Select
                value={f.separation_reason ?? ''}
                onChange={(e) => set('separation_reason', (e.target.value || null) as SeparationReason | null)}
              >
                <option value="">— still employed —</option>
                {Object.entries(SEPARATION_REASON_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Remarks" className="col-span-2">
              <Input value={f.separation_remarks ?? ''} onChange={(e) => set('separation_remarks', e.target.value)} />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            The employee stays on payroll through the last day; run their final pay (with annualization) and
            deactivate their login code when no longer needed.
          </p>
        </Card>

        <Card title="Notes">
          <Textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Card>

        <Button disabled={busy} onClick={save} className="w-full">
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </div>
  )
}

function PayTab({
  employee,
  entity,
  allowances,
  deductions,
  onChanged,
}: {
  employee: Employee
  entity: Entity
  allowances: EmployeeAllowance[]
  deductions: RecurringDeduction[]
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({
    pay_type: employee.pay_type,
    monthly_rate: String(employee.monthly_rate),
    daily_rate: String(employee.daily_rate),
    pay_frequency: employee.pay_frequency,
    days_per_year: employee.days_per_year === null ? '' : String(employee.days_per_year),
    is_mwe: employee.is_minimum_wage_earner,
    payment_method: employee.payment_method,
    bank_name: employee.bank_name ?? '',
    bank_account_no: employee.bank_account_no ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [alwForm, setAlwForm] = useState({ label: '', amount: '', category: 'de_minimis' as AllowanceCategory, basis: 'monthly' as AllowanceBasis })
  const [dedForm, setDedForm] = useState({ label: '', category: 'other', amount: '', total: '' })

  async function savePay() {
    const dpy = f.days_per_year ? Number(f.days_per_year) : null
    if (dpy !== null && !(dpy > 0 && dpy <= 366)) {
      toast('error', 'Days-per-year factor must be between 1 and 366 (or blank for the client default).')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase
        .from('employees')
        .update({
          pay_type: f.pay_type,
          monthly_rate: Number(f.monthly_rate) || 0,
          daily_rate: Number(f.daily_rate) || 0,
          pay_frequency: f.pay_frequency,
          days_per_year: f.days_per_year ? Number(f.days_per_year) : null,
          is_minimum_wage_earner: f.is_mwe,
          payment_method: f.payment_method,
          bank_name: f.bank_name || null,
          bank_account_no: f.bank_account_no || null,
        })
        .eq('id', employee.id)
      if (error) throw error
      toast('success', 'Pay details saved. Record a salary-adjustment career event for rate changes.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  async function addAllowance() {
    if (!alwForm.label || !alwForm.amount) return
    const { error } = await supabase.from('employee_allowances').insert({
      employee_id: employee.id,
      label: alwForm.label,
      amount: Number(alwForm.amount),
      category: alwForm.category,
      basis: alwForm.basis,
    })
    if (error) toast('error', error.message)
    else {
      setAlwForm({ label: '', amount: '', category: 'de_minimis', basis: 'monthly' })
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

  const factor = f.days_per_year ? Number(f.days_per_year) : Number(entity.working_days_divisor)
  const daily = f.pay_type === 'daily' ? Number(f.daily_rate) : ((Number(f.monthly_rate) || 0) * 12) / factor

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Pay and payroll policy">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rate basis">
            <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value as 'monthly' | 'daily' })}>
              <option value="daily">Daily-rated (no work, no pay)</option>
              <option value="monthly">Monthly-rated</option>
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
          <Field label="Pay frequency" hint="The payroll runs this employee is included in">
            <Select value={f.pay_frequency} onChange={(e) => setF({ ...f, pay_frequency: e.target.value as PayFrequency })}>
              {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Days-per-year factor" hint={`Blank = client default (${entity.working_days_divisor})`}>
            <Input type="number" min={1} max={366} value={f.days_per_year} placeholder={String(entity.working_days_divisor)} onChange={(e) => setF({ ...f, days_per_year: e.target.value })} />
          </Field>
          <Field label="Paid by">
            <Select value={f.payment_method} onChange={(e) => setF({ ...f, payment_method: e.target.value as PaymentMethod })}>
              {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <div />
          {f.payment_method !== 'cash' && (
            <>
              <Field label={f.payment_method === 'e_wallet' ? 'E-wallet provider' : 'Bank'}>
                <Input value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} />
              </Field>
              <Field label={f.payment_method === 'e_wallet' ? 'Wallet number' : 'Account no.'}>
                <Input value={f.bank_account_no} onChange={(e) => setF({ ...f, bank_account_no: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3">
          <Toggle
            checked={f.is_mwe}
            onChange={(v) => setF({ ...f, is_mwe: v })}
            label="Minimum wage earner (SMW, holiday, OT, night differential, hazard pay tax-exempt)"
          />
          <p className="text-xs text-slate-500">
            Daily equivalent {money(daily)} vs client minimum {money(Number(entity.minimum_wage_daily))}
            {entity.minimum_wage_region ? ` (${entity.minimum_wage_region})` : ''}.
          </p>
          {Number(employee.rounding_balance) > 0 && (
            <p className="text-xs text-slate-500">
              Cash-rounding centavos owed to this employee: {money(Number(employee.rounding_balance))} (paid on the next payroll).
            </p>
          )}
        </div>
        <Button className="mt-4" disabled={busy} onClick={savePay}>
          {busy ? 'Saving…' : 'Save pay details'}
        </Button>
      </Card>

      <Card title="Allowances and benefits">
        <div className="space-y-2">
          {allowances.length === 0 && <p className="text-sm text-slate-400">None.</p>}
          {allowances.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-700">{a.label}</p>
                <p className="text-xs text-slate-400">
                  {money(Number(a.amount))} {ALLOWANCE_BASIS_LABELS[a.basis]} · {ALLOWANCE_CATEGORY_LABELS[a.category]}
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
          <Input placeholder="Amount" type="number" value={alwForm.amount} onChange={(e) => setAlwForm({ ...alwForm, amount: e.target.value })} />
          <Select value={alwForm.category} onChange={(e) => setAlwForm({ ...alwForm, category: e.target.value as AllowanceCategory })}>
            {Object.entries(ALLOWANCE_CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Select value={alwForm.basis} onChange={(e) => setAlwForm({ ...alwForm, basis: e.target.value as AllowanceBasis })}>
              {Object.entries(ALLOWANCE_BASIS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
            <Button variant="secondary" onClick={addAllowance}><Plus className="size-4" /></Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          De minimis benefits within BIR ceilings (RR 29-2025 for 2026: rice ₱2,500/mo, uniform ₱8,000/yr,
          laundry ₱400/mo, etc.) are non-taxable; bonuses share the ₱90,000 cap with the 13th month pay.
          COLA is exempt for minimum wage earners.
        </p>
      </Card>

      <Card title="Recurring deductions (every payroll)" className="lg:col-span-2">
        <div className="grid gap-2 sm:grid-cols-2">
          {deductions.map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-700">{d.label}</p>
                <p className="text-xs text-slate-400">
                  {money(Number(d.amount_per_period))}/payroll · {d.category.replaceAll('_', ' ')}
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
            <option value="union_dues">Union dues (tax-exempt)</option>
            <option value="other">Other</option>
          </Select>
          <Input placeholder="Amount / payroll" type="number" value={dedForm.amount} onChange={(e) => setDedForm({ ...dedForm, amount: e.target.value })} />
          <div className="flex gap-2">
            <Input placeholder="Total (optional)" type="number" value={dedForm.total} onChange={(e) => setDedForm({ ...dedForm, total: e.target.value })} />
            <Button variant="secondary" onClick={addDeduction}><Plus className="size-4" /></Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Deductions with a total auto-deactivate when the balance reaches zero (decremented on every finalized
          payroll). For one-off items use payroll adjustments on the run itself.
        </p>
      </Card>
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
    separation_reason: 'resignation' as SeparationReason,
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
        details:
          f.event_type === 'separated'
            ? [SEPARATION_REASON_LABELS[f.separation_reason], f.details].filter(Boolean).join(' — ')
            : f.details,
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
          upd.separation_date = f.effective_date
          upd.separation_reason = f.separation_reason
          upd.separation_remarks = f.details || null
        }
        if (Object.keys(upd).length > 0) {
          const { error: updErr } = await supabase.from('employees').update(upd).eq('id', employee.id)
          if (updErr) throw updErr
        }
      }
      toast('success', 'Career event recorded.')
      setAdding(false)
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
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
            <Field label={f.event_type === 'separated' ? 'Last day of employment' : 'Effective date'}>
              <Input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} />
            </Field>
            {f.event_type === 'separated' ? (
              <Field label="Reason" className="col-span-2">
                <Select value={f.separation_reason} onChange={(e) => setF({ ...f, separation_reason: e.target.value as SeparationReason })}>
                  {Object.entries(SEPARATION_REASON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <>
                <Field label="Position"><Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></Field>
                <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
                <Field label="New monthly rate"><Input type="number" value={f.monthly_rate} onChange={(e) => setF({ ...f, monthly_rate: e.target.value })} /></Field>
                <Field label="New daily rate"><Input type="number" value={f.daily_rate} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} /></Field>
              </>
            )}
          </div>
          <Field label="Details"><Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
          <Toggle checked={f.apply} onChange={(v) => setF({ ...f, apply: v })} label="Also update the employee's current record" />
          <Button className="w-full" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Record event'}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

function LoginTab({
  employee,
  entity,
  account,
  onChanged,
}: {
  employee: Employee
  entity: Entity
  account: Profile | null
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [part, setPart] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function setCode() {
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'set_employee_code', employee_id: employee.id, code_part: part })
      if (res.error) throw new Error(res.error)
      setIssued(res.code ?? null)
      setPart('')
      toast('success', account ? 'New code set — the old code no longer works.' : 'Login code issued.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  async function setActive(active: boolean) {
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'set_employee_login_active', employee_id: employee.id, active })
      if (res.error) throw new Error(res.error)
      toast('success', active ? 'Login reactivated.' : 'Login deactivated.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  function printSlip(code: string) {
    const w = window.open('', '_blank', 'width=420,height=320')
    if (!w) return
    // Names are admin-entered text: escape them, the popup shares our origin.
    const esc = (v: string) =>
      v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    w.document.write(
      `<html><head><title>Login code</title></head><body style="font-family:sans-serif;padding:24px">
       <p style="margin:0;color:#475569;font-size:12px">${esc(entity.name)}</p>
       <h2 style="margin:4px 0 12px">${esc(fullName(employee))}</h2>
       <p style="margin:0;font-size:12px;color:#475569">Your Payslip HR login code</p>
       <p style="font-family:monospace;font-size:26px;font-weight:bold;letter-spacing:2px;margin:6px 0 16px">${esc(code)}</p>
       <p style="font-size:11px;color:#64748b">Sign in at ${esc(window.location.origin + import.meta.env.BASE_URL)} — choose "Employee". Keep this code private.</p>
       </body></html>`,
    )
    w.document.close()
    w.print()
  }

  return (
    <Card title="Employee login code">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          {account ? (
            <>
              <UserCheck className="size-5 text-emerald-500" />
              <div>
                <p className="text-sm font-semibold text-slate-700">
                  Code <span className="font-mono">{entity.code}-••••{employee.login_code_hint ?? ''}</span>
                </p>
                <p className="text-xs text-slate-400">
                  Set {fmtDateTime(employee.login_code_set_at)} · the code itself is never stored, only its last characters
                </p>
              </div>
              <Badge tone={account.is_active ? 'green' : 'red'}>{account.is_active ? 'Active' : 'Deactivated'}</Badge>
            </>
          ) : (
            <p className="text-sm text-slate-600">
              No login yet. Issue a code so this employee can see payslips, attendance, leaves and announcements.
            </p>
          )}
        </div>

        {issued && (
          <div className="rounded-xl border-2 border-dashed border-accent-300 bg-accent-50 p-4">
            <p className="text-xs font-semibold text-accent-800">Give this code to the employee — it is shown only now:</p>
            <p className="my-1 font-mono text-2xl font-extrabold tracking-wider text-brand-900">{issued}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(issued)}>
                <Copy className="size-4" /> Copy
              </Button>
              <Button variant="secondary" onClick={() => printSlip(issued)}>
                <Printer className="size-4" /> Print slip
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label={account ? 'New code' : 'Code'} hint="8–24 letters or digits; not the employee number">
            <div className="flex items-center gap-1">
              <span className="rounded-lg bg-slate-100 px-2.5 py-2 font-mono text-sm font-bold text-slate-600">{entity.code}-</span>
              <Input
                value={part}
                maxLength={24}
                onChange={(e) => setPart(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                className="w-48 font-mono uppercase"
              />
            </div>
          </Field>
          <Button variant="secondary" onClick={() => setPart(generateCodePart())}>
            <RefreshCw className="size-4" /> Generate
          </Button>
          <Button disabled={busy || part.length < 8} onClick={setCode}>
            <KeyRound className="size-4" /> {account ? 'Replace code' : 'Issue code'}
          </Button>
          {account && (
            <Button variant={account.is_active ? 'danger' : 'primary'} disabled={busy} onClick={() => setActive(!account.is_active)}>
              <UserX className="size-4" /> {account.is_active ? 'Deactivate login' : 'Reactivate login'}
            </Button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Employees sign in with the full code ({entity.code}-…). Replacing a code signs the employee out of every
          device. Employees can only view their own records — they cannot change attendance or pay.
        </p>
      </div>
    </Card>
  )
}

const TAX_FIELDS: { key: keyof EmployeeTaxYear; label: string }[] = [
  { key: 'prev_mwe_exempt', label: 'MWE exempt pay (SMW, holiday, OT, ND, hazard)' },
  { key: 'prev_13th_other_benefits_exempt', label: '13th month & other benefits (exempt)' },
  { key: 'prev_de_minimis', label: 'De minimis benefits' },
  { key: 'prev_contributions', label: 'SSS/PhilHealth/Pag-IBIG & union dues (EE)' },
  { key: 'prev_other_non_taxable', label: 'Other non-taxable compensation' },
  { key: 'prev_taxable_basic', label: 'Taxable basic salary' },
  { key: 'prev_taxable_13th_other_benefits', label: 'Taxable 13th month & other benefits' },
  { key: 'prev_taxable_other', label: 'Other taxable compensation' },
  { key: 'prev_tax_withheld', label: 'Tax withheld by previous employer' },
]

function BirTab({ employee }: { employee: Employee }) {
  const toast = useToast()
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)))
  const [row, setRow] = useState<Partial<EmployeeTaxYear> | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRow(null)
    supabase
      .from('employee_tax_years')
      .select('*')
      .eq('employee_id', employee.id)
      .eq('year', year)
      .maybeSingle()
      .then(({ data }) => setRow((data as EmployeeTaxYear) ?? { has_previous_employer: false, substituted_filing: 'auto', pera_tax_credit: 0 }))
  }, [employee.id, year])

  if (!row) return <Spinner />
  const set = (k: keyof EmployeeTaxYear, v: unknown) => setRow({ ...row, [k]: v })

  async function save() {
    if (!row) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        employee_id: employee.id,
        year,
        has_previous_employer: !!row.has_previous_employer,
        prev_employer_tin: row.prev_employer_tin ?? '',
        prev_employer_name: row.prev_employer_name ?? '',
        prev_employer_address: row.prev_employer_address ?? '',
        prev_employer_zip: row.prev_employer_zip ?? '',
        prev_employment_from: row.prev_employment_from || null,
        prev_employment_to: row.prev_employment_to || null,
        pera_tax_credit: Number(row.pera_tax_credit ?? 0),
        substituted_filing: row.substituted_filing ?? 'auto',
        notes: row.notes ?? '',
      }
      for (const f of TAX_FIELDS) payload[f.key] = Number(row[f.key] ?? 0)
      const { error } = await supabase.from('employee_tax_years').upsert(payload, { onConflict: 'employee_id,year' })
      if (error) throw error
      toast('success', `BIR data for ${year} saved.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="Previous employer this year (from their BIR Form 2316)"
        actions={
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        }
      >
        <Toggle
          checked={!!row.has_previous_employer}
          onChange={(v) => set('has_previous_employer', v)}
          label={`Had another employer earlier in ${year}`}
        />
        {row.has_previous_employer && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Previous employer TIN"><Input value={row.prev_employer_tin ?? ''} onChange={(e) => set('prev_employer_tin', e.target.value)} /></Field>
              <Field label="Name"><Input value={row.prev_employer_name ?? ''} onChange={(e) => set('prev_employer_name', e.target.value)} /></Field>
              <Field label="Address" className="col-span-2"><Input value={row.prev_employer_address ?? ''} onChange={(e) => set('prev_employer_address', e.target.value)} /></Field>
              <Field label="ZIP"><Input value={row.prev_employer_zip ?? ''} onChange={(e) => set('prev_employer_zip', e.target.value)} /></Field>
              <div />
              <Field label="Employed from"><Input type="date" value={row.prev_employment_from ?? ''} onChange={(e) => set('prev_employment_from', e.target.value)} /></Field>
              <Field label="Employed to"><Input type="date" value={row.prev_employment_to ?? ''} onChange={(e) => set('prev_employment_to', e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {TAX_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <Input type="number" step="0.01" value={String(row[f.key] ?? 0)} onChange={(e) => set(f.key, e.target.value)} />
                </Field>
              ))}
            </div>
          </div>
        )}
      </Card>
      <Card title={`Year-end details for ${year}`}>
        <div className="space-y-3">
          <Field label="Substituted filing" hint="Auto = qualifies when the employee had only this employer all year and taxes withheld equal tax due">
            <Select value={row.substituted_filing ?? 'auto'} onChange={(e) => set('substituted_filing', e.target.value)}>
              <option value="auto">Automatic</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="PERA 5% tax credit (RA 9505)">
            <Input type="number" step="0.01" value={String(row.pera_tax_credit ?? 0)} onChange={(e) => set('pera_tax_credit', e.target.value)} />
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={row.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save BIR data'}</Button>
          <p className="text-xs text-slate-400">
            Used by year-end annualization and the 1604-C alphalist (BIR &amp; Reports).
          </p>
        </div>
      </Card>
    </div>
  )
}
