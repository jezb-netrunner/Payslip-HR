import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound, Plus, Search } from 'lucide-react'
import { Badge, Button, Field, Input, LoadFailed, Modal, NoClient, PageHeader, Select, Spinner, TableShell, Td, Th, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, isActiveOn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, EmploymentStatus, Entity, PaymentMethod } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fullName, initials, money } from '../../lib/format'
import {
  EMPLOYMENT_STATUS_LABELS,
  FREQUENCY_LABELS,
  PAYMENT_METHOD_LABELS,
  SEPARATION_REASON_LABELS,
} from '../../lib/labels'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import type { PayFrequency } from '../../payroll/types'
import { errorMessage } from '../../lib/errors'

const statusTones: Record<string, string> = {
  regular: 'green',
  probationary: 'amber',
  casual: 'blue',
  contractual: 'blue',
  project_based: 'blue',
  seasonal: 'violet',
  apprentice: 'violet',
}

export default function Employees() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <EmployeeList key={entity.id} entity={entity} />
}

function EmployeeList({ entity }: { entity: Entity }) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [showSeparated, setShowSeparated] = useState(false)
  const [frequency, setFrequency] = useState('')
  const [adding, setAdding] = useState(false)
  const navigate = useNavigate()
  const today = todayManila()

  const load = useCallback(async () => {
    setLoadError('')
    try {
      setEmployees(await getEmployees(entity.id))
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load employees'))
    } finally {
      setLoading(false)
    }
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  const filtered = employees.filter((e) => {
    if (!showSeparated && !isActiveOn(e, today)) return false
    if (frequency && e.pay_frequency !== frequency) return false
    const q = query.toLowerCase()
    return (
      !q ||
      fullName(e).toLowerCase().includes(q) ||
      e.employee_no.toLowerCase().includes(q) ||
      e.position.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q)
    )
  })
  const activeCount = employees.filter((e) => isActiveOn(e, today)).length

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${entity.name} · ${activeCount} active, ${employees.length - activeCount} separated`}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add employee
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
          <Input
            placeholder="Search name, number, position…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="w-44">
          <option value="">All pay frequencies</option>
          {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showSeparated}
            onChange={(e) => setShowSeparated(e.target.checked)}
            className="rounded border-slate-300"
          />
          Show separated
        </label>
      </div>

      {loadError ? (
        <LoadFailed message={loadError} onRetry={load} />
      ) : loading ? (
        <Spinner />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Employee</Th>
              <Th>Position / Dept</Th>
              <Th>Status</Th>
              <Th>Employment</Th>
              <Th>Pay</Th>
              <Th>Login</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((e) => {
              const separated = !isActiveOn(e, today)
              return (
                <tr
                  key={e.id}
                  className="cursor-pointer hover:bg-brand-50/40"
                  onClick={() => navigate(`/admin/employees/${e.id}`)}
                >
                  <Td>
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                        {initials(fullName(e))}
                      </div>
                      <div>
                        {/* a real link: keyboard and screen-reader users can open the record too */}
                        <Link
                          to={`/admin/employees/${e.id}`}
                          onClick={(ev) => ev.stopPropagation()}
                          className="font-semibold text-slate-800 hover:text-brand-700 hover:underline"
                        >
                          {fullName(e)}
                        </Link>
                        <p className="text-xs text-slate-400">{e.employee_no}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <p>{e.position || '—'}</p>
                    <p className="text-xs text-slate-400">{e.department || '—'}</p>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={statusTones[e.employment_status] ?? 'slate'}>
                        {EMPLOYMENT_STATUS_LABELS[e.employment_status]}
                      </Badge>
                      {e.is_minimum_wage_earner && <Badge tone="orange">MWE</Badge>}
                      {separated && <Badge tone="red">separated</Badge>}
                    </div>
                  </Td>
                  <Td className="text-xs">
                    <p>Started {fmtDate(e.hire_date)}</p>
                    {e.separation_date && (
                      <p className={separated ? 'text-rose-600' : 'text-amber-600'}>
                        {separated ? 'Left' : 'Leaving'} {fmtDate(e.separation_date)}
                        {e.separation_reason ? ` · ${SEPARATION_REASON_LABELS[e.separation_reason]}` : ''}
                      </p>
                    )}
                  </Td>
                  <Td className="text-xs">
                    <p className="text-sm">
                      {e.pay_type === 'monthly'
                        ? `${money(Number(e.monthly_rate))}/mo`
                        : `${money(Number(e.daily_rate))}/day`}
                    </p>
                    <p className="text-slate-400">
                      {FREQUENCY_LABELS[e.pay_frequency]} · {PAYMENT_METHOD_LABELS[e.payment_method]}
                    </p>
                  </Td>
                  <Td>
                    {e.login_code_hint ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-700">
                        <KeyRound className="size-3.5" /> ••••{e.login_code_hint}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">no code</span>
                    )}
                  </Td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <Td className="py-8 text-center text-slate-400" colSpan={6}>
                  No employees found
                </Td>
              </tr>
            )}
          </tbody>
        </TableShell>
      )}

      <AddEmployeeModal
        open={adding}
        entity={entity}
        onClose={() => setAdding(false)}
        onCreated={async (id) => {
          setAdding(false)
          await load()
          navigate(`/admin/employees/${id}`)
        }}
        nextNumber={`${entity.code}-${String(employees.length + 1).padStart(4, '0')}`}
      />
    </div>
  )
}

function AddEmployeeModal({
  open,
  entity,
  onClose,
  onCreated,
  nextNumber,
}: {
  open: boolean
  entity: Entity
  onClose: () => void
  onCreated: (id: string) => void
  nextNumber: string
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const blank = () => ({
    employee_no: '',
    first_name: '',
    middle_name: '',
    last_name: '',
    hire_date: todayManila(),
    employment_status: 'probationary' as EmploymentStatus,
    position: '',
    department: '',
    pay_type: 'daily' as 'daily' | 'monthly',
    rate: '',
    pay_frequency: entity.default_pay_frequency as PayFrequency,
    payment_method: 'cash' as PaymentMethod,
    is_mwe: false,
  })
  const [f, setF] = useState(blank)

  useEffect(() => {
    if (open) setF((prev) => ({ ...prev, employee_no: prev.employee_no || nextNumber }))
  }, [open, nextNumber])

  const rate = Number(f.rate) || 0
  const dailyEquivalent =
    f.pay_type === 'daily' ? rate : (rate * 12) / Number(entity.working_days_divisor || 261)
  const minWage = Number(entity.minimum_wage_daily)
  const atMinimum = rate > 0 && minWage > 0 && dailyEquivalent <= minWage + 0.005

  async function save() {
    if (!f.first_name.trim() || !f.last_name.trim() || !f.employee_no.trim()) {
      toast('error', 'Name and employee number are required.')
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('employees')
        .insert({
          entity_id: entity.id,
          employee_no: f.employee_no.trim(),
          first_name: f.first_name.trim(),
          middle_name: f.middle_name.trim() || null,
          last_name: f.last_name.trim(),
          hire_date: f.hire_date,
          employment_status: f.employment_status,
          position: f.position.trim(),
          department: f.department.trim(),
          pay_type: f.pay_type,
          monthly_rate: f.pay_type === 'monthly' ? rate : 0,
          daily_rate: f.pay_type === 'daily' ? rate : 0,
          pay_frequency: f.pay_frequency,
          payment_method: f.payment_method,
          is_minimum_wage_earner: f.is_mwe,
        })
        .select('id')
        .single()
      if (error) throw error
      await supabase.from('career_events').insert({
        employee_id: data.id,
        event_type: 'hired',
        effective_date: f.hire_date,
        position: f.position.trim(),
        department: f.department.trim(),
        monthly_rate: f.pay_type === 'monthly' ? rate || null : null,
        daily_rate: f.pay_type === 'daily' ? rate || null : null,
        details: 'Start of employment',
      })
      toast('success', 'Employee added. Complete their 201 file and issue a login code next.')
      setF(blank())
      onCreated(data.id)
    } catch (err) {
      const msg = errorMessage(err, 'Failed to add employee')
      toast('error', /employee_no/.test(msg) ? 'That employee number is already used in this client.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Add employee — ${entity.name}`} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Employee no.">
            <Input value={f.employee_no} onChange={(e) => setF({ ...f, employee_no: e.target.value })} />
          </Field>
          <Field label="First name">
            <Input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
          </Field>
          <Field label="Middle name">
            <Input value={f.middle_name} onChange={(e) => setF({ ...f, middle_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
          </Field>
          <Field label="Date started">
            <Input type="date" value={f.hire_date} onChange={(e) => setF({ ...f, hire_date: e.target.value })} />
          </Field>
          <Field label="Employment status">
            <Select
              value={f.employment_status}
              onChange={(e) => setF({ ...f, employment_status: e.target.value as EmploymentStatus })}
            >
              {Object.entries(EMPLOYMENT_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Position">
            <Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
          </Field>
          <Field label="Department">
            <Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Rate basis">
            <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value as 'daily' | 'monthly' })}>
              <option value="daily">Daily-rated</option>
              <option value="monthly">Monthly-rated</option>
            </Select>
          </Field>
          <Field label={f.pay_type === 'daily' ? 'Daily rate (PHP)' : 'Monthly rate (PHP)'}>
            <Input type="number" min="0" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
          <Field label="Paid">
            <Select value={f.pay_frequency} onChange={(e) => setF({ ...f, pay_frequency: e.target.value as PayFrequency })}>
              {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Paid by">
            <Select value={f.payment_method} onChange={(e) => setF({ ...f, payment_method: e.target.value as PaymentMethod })}>
              {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <Toggle
            checked={f.is_mwe}
            onChange={(v) => setF({ ...f, is_mwe: v })}
            label="Minimum wage earner (statutory minimum wage, holiday, OT, night differential and hazard pay are tax-exempt)"
          />
          {atMinimum && !f.is_mwe && (
            <p className="mt-2 text-xs text-amber-700">
              This rate is at or below the client's minimum wage ({money(minWage)}/day) — mark as MWE if it is the
              statutory minimum wage.
            </p>
          )}
          {rate > 0 && minWage > 0 && dailyEquivalent + 0.005 < minWage && (
            <p className="mt-1 text-xs text-rose-600">
              Below the configured minimum wage of {money(minWage)}/day.
            </p>
          )}
        </div>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add employee'}
        </Button>
      </div>
    </Modal>
  )
}
