import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Card, EmptyState, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useAuth } from '../../lib/auth'
import type { AuditLog as AuditRow } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDateTime } from '../../lib/format'
import { supabase } from '../../lib/supabase'

const actionTones: Record<string, string> = {
  insert: 'green',
  update: 'amber',
  delete: 'red',
}

const TABLES: Record<string, string> = {
  employees: 'Employees',
  time_entries: 'Time entries',
  payroll_runs: 'Payroll runs',
  payroll_adjustments: 'Payroll adjustments',
  employee_allowances: 'Allowances',
  recurring_deductions: 'Recurring deductions',
  entities: 'Client settings',
  holidays: 'Holidays',
  tax_remittances: 'BIR remittances',
  statutory_versions: 'Statutory tables',
  entity_admins: 'Admin assignments',
  profiles: 'User accounts',
  leave_requests: 'Leave requests',
  time_correction_requests: 'Time corrections',
  announcements: 'Announcements',
  career_events: 'Career events',
  employee_tax_years: 'BIR tax-year data',
  employee_leave_entitlements: 'Leave credits',
  leave_types: 'Leave types',
}

export default function AuditLog() {
  const { isCompanyAdmin } = useAuth()
  const { entity } = useEntity()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [table, setTable] = useState('')
  const [scope, setScope] = useState<'client' | 'global'>('client')
  const [loading, setLoading] = useState(true)

  const latest = useRef(0)
  const load = useCallback(async () => {
    const mine = ++latest.current
    // client scope needs a client: never fall back to an unfiltered query
    if (scope === 'client' && !entity) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    let q = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(300)
    if (scope === 'global') q = q.is('entity_id', null)
    else if (entity) q = q.eq('entity_id', entity.id)
    if (table) q = q.eq('table_name', table)
    const { data } = await q
    if (mine !== latest.current) return // a newer filter/client superseded this request
    setRows((data ?? []) as AuditRow[])
    setLoading(false)
  }, [table, scope, entity])

  useEffect(() => {
    load()
  }, [load])

  function changedFields(r: AuditRow): string {
    if (r.action !== 'update' || !r.old_data || !r.new_data) return ''
    const oldD = r.old_data as Record<string, unknown>
    const newD = r.new_data as Record<string, unknown>
    const changed = Object.keys(newD).filter(
      (k) => k !== 'updated_at' && JSON.stringify(oldD[k]) !== JSON.stringify(newD[k]),
    )
    return changed.slice(0, 6).join(', ') + (changed.length > 6 ? '…' : '')
  }

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Database-level trail of sensitive changes, recorded by triggers — not editable by anyone."
        actions={
          <>
            {isCompanyAdmin && (
              <Select value={scope} onChange={(e) => setScope(e.target.value as 'client' | 'global')} className="w-52">
                <option value="client">{entity ? `Client: ${entity.code}` : 'Selected client'}</option>
                <option value="global">Global (statutory, users)</option>
              </Select>
            )}
            <Select value={table} onChange={(e) => setTable(e.target.value)} className="w-52">
              <option value="">All record types</option>
              {Object.entries(TABLES).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </>
        }
      />
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card><EmptyState title="No audit entries" /></Card>
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Record</Th>
              <Th>Changed</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</Td>
                <Td className="text-xs">{r.actor_email ?? (r.actor_id ? r.actor_id.slice(0, 8) : 'system')}</Td>
                <Td><Badge tone={actionTones[r.action] ?? 'slate'}>{r.action}</Badge></Td>
                <Td className="text-xs">
                  {TABLES[r.table_name] ?? r.table_name}
                  <span className="text-slate-400"> {r.record_id?.slice(0, 8)}</span>
                </Td>
                <Td className="max-w-md truncate text-xs text-slate-500">{changedFields(r)}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
