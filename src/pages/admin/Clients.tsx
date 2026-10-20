import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArrowRight, Plus, RotateCcw } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Entity } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtTin, money } from '../../lib/format'
import { FREQUENCY_LABELS, PH_REGIONS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'
import type { PayFrequency } from '../../payroll/types'

export default function Clients() {
  const toast = useToast()
  const navigate = useNavigate()
  const { entities, reload, setEntityId, loading } = useEntity()
  const [headcount, setHeadcount] = useState<Record<string, number>>({})
  const [admins, setAdmins] = useState<Record<string, number>>({})
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const loadCounts = useCallback(async () => {
    const [{ data: emps }, { data: links }] = await Promise.all([
      supabase.from('employees').select('entity_id, separation_date'),
      supabase.from('entity_admins').select('entity_id'),
    ])
    const today = new Date().toISOString().slice(0, 10)
    const hc: Record<string, number> = {}
    for (const e of emps ?? []) {
      if (e.separation_date && e.separation_date < today) continue
      hc[e.entity_id as string] = (hc[e.entity_id as string] ?? 0) + 1
    }
    const ad: Record<string, number> = {}
    for (const l of links ?? []) ad[l.entity_id as string] = (ad[l.entity_id as string] ?? 0) + 1
    setHeadcount(hc)
    setAdmins(ad)
  }, [])

  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  async function setActive(e: Entity, active: boolean) {
    if (!active && !confirm(`Archive ${e.name}? Its entity admins lose access; records are kept.`)) return
    const { error } = await supabase.from('entities').update({ is_active: active }).eq('id', e.id)
    if (error) toast('error', error.message)
    else {
      toast('success', active ? 'Client reactivated.' : 'Client archived.')
      await reload()
    }
  }

  function open(e: Entity, to: string) {
    setEntityId(e.id)
    navigate(to)
  }

  const shown = entities.filter((e) => showArchived || e.is_active)

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Each client is a separate employer (BIR withholding agent) with its own employees, payroll and admins."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add client
          </Button>
        }
      />
      <label className="mb-4 flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="rounded border-slate-300"
        />
        Show archived clients
      </label>
      {loading ? (
        <Spinner />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Client</Th>
              <Th>TIN / RDO</Th>
              <Th>Minimum wage</Th>
              <Th className="text-right">Employees</Th>
              <Th className="text-right">Entity admins</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50">
                <Td>
                  <p className="font-semibold text-slate-800">{e.name}</p>
                  <p className="text-xs text-slate-400">
                    Code <span className="font-mono font-bold">{e.code}</span>
                    {e.trade_name ? ` · ${e.trade_name}` : ''}
                  </p>
                </Td>
                <Td className="text-xs">
                  {e.tin ? fmtTin(e.tin, e.tin_branch_code) : <span className="text-amber-600">TIN missing</span>}
                  {e.rdo_code && <span className="text-slate-400"> · RDO {e.rdo_code}</span>}
                </Td>
                <Td className="text-xs">
                  {e.minimum_wage_region || '—'} · {money(Number(e.minimum_wage_daily))}/day
                </Td>
                <Td className="text-right">{headcount[e.id] ?? 0}</Td>
                <Td className="text-right">{admins[e.id] ?? 0}</Td>
                <Td>{e.is_active ? <Badge tone="green">active</Badge> : <Badge tone="slate">archived</Badge>}</Td>
                <Td>
                  <div className="flex items-center justify-end gap-3">
                    {e.is_active ? (
                      <>
                        <button
                          onClick={() => open(e, '/admin/settings')}
                          className="text-xs font-semibold text-slate-500 hover:text-brand-700"
                        >
                          Settings
                        </button>
                        <button
                          onClick={() => open(e, '/admin')}
                          className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
                        >
                          Open <ArrowRight className="size-3.5" />
                        </button>
                        <button title="Archive" onClick={() => setActive(e, false)} className="text-slate-300 hover:text-rose-500">
                          <Archive className="size-4" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setActive(e, true)}
                        className="flex items-center gap-1 text-xs font-semibold text-brand-600"
                      >
                        <RotateCcw className="size-3.5" /> Reactivate
                      </button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <Td colSpan={7} className="py-8 text-center text-slate-400">
                  No clients yet — add your first client.
                </Td>
              </tr>
            )}
          </tbody>
        </TableShell>
      )}

      <AddClientModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={async (id) => {
          setAdding(false)
          await reload()
          await loadCounts()
          setEntityId(id)
          navigate('/admin/settings')
        }}
      />
    </div>
  )
}

function AddClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    code: '',
    name: '',
    trade_name: '',
    tin: '',
    tin_branch_code: '00000',
    rdo_code: '',
    minimum_wage_region: '',
    minimum_wage_daily: '',
    minimum_wage_reference: '',
    default_pay_frequency: 'semi_monthly' as PayFrequency,
  })

  async function save() {
    const code = f.code.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(code)) {
      toast('error', 'Client code: 2–10 letters/digits, starting with a letter (e.g. ACME).')
      return
    }
    if (!f.name.trim()) {
      toast('error', 'Registered name is required.')
      return
    }
    if (!f.minimum_wage_region || !(Number(f.minimum_wage_daily) > 0)) {
      toast('error', 'Set the region and its current daily minimum wage.')
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('entities')
        .insert({
          code,
          name: f.name.trim(),
          trade_name: f.trade_name.trim(),
          tin: f.tin.trim(),
          tin_branch_code: f.tin_branch_code.trim() || '00000',
          rdo_code: f.rdo_code.trim(),
          minimum_wage_region: f.minimum_wage_region,
          minimum_wage_daily: Number(f.minimum_wage_daily),
          minimum_wage_reference: f.minimum_wage_reference.trim(),
          default_pay_frequency: f.default_pay_frequency,
        })
        .select('id')
        .single()
      if (error) throw error
      toast('success', 'Client added with the statutory leave types. Review its payroll settings next.')
      onCreated(data.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add client'
      toast('error', /entities_code_key/.test(msg) ? 'That client code is already taken.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add client" wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Client code" hint="Prefix of every employee login code. Cannot be changed later.">
            <Input
              value={f.code}
              maxLength={10}
              onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
              className="font-mono uppercase"
              placeholder="ACME"
            />
          </Field>
          <Field label="Registered name" className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Trade / business name">
            <Input value={f.trade_name} onChange={(e) => setF({ ...f, trade_name: e.target.value })} />
          </Field>
          <Field label="TIN" hint="000-000-000">
            <Input value={f.tin} onChange={(e) => setF({ ...f, tin: e.target.value })} />
          </Field>
          <Field label="Branch code / RDO">
            <div className="flex gap-2">
              <Input value={f.tin_branch_code} onChange={(e) => setF({ ...f, tin_branch_code: e.target.value })} />
              <Input placeholder="RDO" value={f.rdo_code} onChange={(e) => setF({ ...f, rdo_code: e.target.value })} />
            </div>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Wage region">
            <Select value={f.minimum_wage_region} onChange={(e) => setF({ ...f, minimum_wage_region: e.target.value })}>
              <option value="">Select…</option>
              {PH_REGIONS.map((r) => (
                <option key={r.code} value={r.code}>{r.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Daily minimum wage (PHP)" hint="Current wage order for the client's region and sector">
            <Input
              type="number"
              step="0.01"
              value={f.minimum_wage_daily}
              onChange={(e) => setF({ ...f, minimum_wage_daily: e.target.value })}
            />
          </Field>
          <Field label="Wage order reference">
            <Input
              placeholder="e.g. WO NCR-27, eff. 25 Jul 2026"
              value={f.minimum_wage_reference}
              onChange={(e) => setF({ ...f, minimum_wage_reference: e.target.value })}
            />
          </Field>
          <Field label="Default pay frequency" hint="New employees start with this; each employee can differ.">
            <Select
              value={f.default_pay_frequency}
              onChange={(e) => setF({ ...f, default_pay_frequency: e.target.value as PayFrequency })}
            >
              {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add client'}
        </Button>
      </div>
    </Modal>
  )
}
