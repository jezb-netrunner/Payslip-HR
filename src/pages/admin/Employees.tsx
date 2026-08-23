import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Employee } from '../../lib/db'
import { fmtDate, fullName, initials, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

const statusTones: Record<string, string> = {
  regular: 'green',
  probationary: 'amber',
  contractual: 'blue',
  project_based: 'blue',
  part_time: 'violet',
  resigned: 'slate',
  terminated: 'red',
  retired: 'slate',
}

export default function Employees() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [adding, setAdding] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const { data } = await supabase.from('employees').select('*').order('last_name')
    setEmployees((data ?? []) as Employee[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const inactive = ['resigned', 'terminated', 'retired']
  const filtered = employees.filter((e) => {
    if (!showInactive && inactive.includes(e.employment_status)) return false
    const q = query.toLowerCase()
    return (
      !q ||
      fullName(e).toLowerCase().includes(q) ||
      e.employee_no.toLowerCase().includes(q) ||
      e.position.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q)
    )
  })

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${filtered.length} of ${employees.length} employee/s`}
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
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-slate-300"
          />
          Show separated
        </label>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Employee</Th>
              <Th>Position / Dept</Th>
              <Th>Status</Th>
              <Th>Hired</Th>
              <Th>Rate</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((e) => (
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
                      <p className="font-semibold text-slate-800">{fullName(e)}</p>
                      <p className="text-xs text-slate-400">{e.employee_no} · {e.email}</p>
                    </div>
                  </div>
                </Td>
                <Td>
                  <p>{e.position || '—'}</p>
                  <p className="text-xs text-slate-400">{e.department || '—'}</p>
                </Td>
                <Td>
                  <Badge tone={statusTones[e.employment_status] ?? 'slate'}>
                    {e.employment_status.replaceAll('_', ' ')}
                  </Badge>
                  {e.is_minimum_wage_earner && <Badge tone="orange">MWE</Badge>}
                </Td>
                <Td>{fmtDate(e.hire_date)}</Td>
                <Td>
                  {e.pay_type === 'monthly'
                    ? `${money(Number(e.monthly_rate))}/mo`
                    : `${money(Number(e.daily_rate))}/day`}
                </Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <Td className="py-8 text-center text-slate-400" colSpan={5}>
                  No employees found
                </Td>
              </tr>
            )}
          </tbody>
        </TableShell>
      )}

      <AddEmployeeModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={async (id) => {
          setAdding(false)
          await load()
          navigate(`/admin/employees/${id}`)
        }}
        nextNumber={`EMP-${String(employees.length + 1).padStart(4, '0')}`}
      />
    </div>
  )
}

function AddEmployeeModal({
  open,
  onClose,
  onCreated,
  nextNumber,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
  nextNumber: string
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    employee_no: '',
    first_name: '',
    last_name: '',
    email: '',
    position: '',
    department: '',
    hire_date: todayManila(),
    pay_type: 'monthly',
    monthly_rate: '',
    daily_rate: '',
  })

  useEffect(() => {
    if (open) setF((prev) => ({ ...prev, employee_no: prev.employee_no || nextNumber }))
  }, [open, nextNumber])

  async function save() {
    if (!f.first_name || !f.last_name || !f.email || !f.employee_no) {
      toast('error', 'Name, employee number and email are required.')
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('employees')
        .insert({
          employee_no: f.employee_no.trim(),
          first_name: f.first_name.trim(),
          last_name: f.last_name.trim(),
          email: f.email.trim().toLowerCase(),
          position: f.position.trim(),
          department: f.department.trim(),
          hire_date: f.hire_date,
          pay_type: f.pay_type,
          monthly_rate: Number(f.monthly_rate) || 0,
          daily_rate: Number(f.daily_rate) || 0,
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
        monthly_rate: Number(f.monthly_rate) || null,
        daily_rate: Number(f.daily_rate) || null,
        details: 'Start of employment',
      })
      toast('success', 'Employee added. Complete their profile and create their login next.')
      onCreated(data.id)
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to add employee')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add employee">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee no.">
            <Input value={f.employee_no} onChange={(e) => setF({ ...f, employee_no: e.target.value })} />
          </Field>
          <Field label="Date hired">
            <Input type="date" value={f.hire_date} onChange={(e) => setF({ ...f, hire_date: e.target.value })} />
          </Field>
          <Field label="First name">
            <Input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
          </Field>
        </div>
        <Field label="Email" hint="Used for their employee login later.">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Position">
            <Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
          </Field>
          <Field label="Department">
            <Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />
          </Field>
          <Field label="Pay type">
            <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value })}>
              <option value="monthly">Monthly-paid</option>
              <option value="daily">Daily-paid</option>
            </Select>
          </Field>
          {f.pay_type === 'monthly' ? (
            <Field label="Monthly rate (PHP)">
              <Input type="number" min="0" value={f.monthly_rate} onChange={(e) => setF({ ...f, monthly_rate: e.target.value })} />
            </Field>
          ) : (
            <Field label="Daily rate (PHP)">
              <Input type="number" min="0" value={f.daily_rate} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} />
            </Field>
          )}
        </div>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add employee'}
        </Button>
      </div>
    </Modal>
  )
}
