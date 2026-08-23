import { useCallback, useEffect, useState } from 'react'
import { Badge, Card, EmptyState, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import type { AuditLog as AuditRow, Profile } from '../../lib/db'
import { fmtDateTime } from '../../lib/format'
import { supabase } from '../../lib/supabase'

const actionTones: Record<string, string> = {
  insert: 'green',
  update: 'amber',
  delete: 'red',
}

export default function AuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [profiles, setProfiles] = useState<Record<string, Profile>>({})
  const [entity, setEntity] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200)
    if (entity) q = q.eq('entity', entity)
    const [{ data }, { data: profs }] = await Promise.all([
      q,
      supabase.from('profiles').select('*'),
    ])
    setRows((data ?? []) as AuditRow[])
    const map: Record<string, Profile> = {}
    for (const p of (profs ?? []) as Profile[]) map[p.id] = p
    setProfiles(map)
    setLoading(false)
  }, [entity])

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
        subtitle="Database-level trail of sensitive changes — employees, time entries, payroll runs, settings, statutory tables"
        actions={
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-52">
            <option value="">All entities</option>
            <option value="employees">Employees</option>
            <option value="time_entries">Time entries</option>
            <option value="payroll_runs">Payroll runs</option>
            <option value="company_settings">Company settings</option>
            <option value="statutory_versions">Statutory tables</option>
          </Select>
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
              <Th>Entity</Th>
              <Th>Changed</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</Td>
                <Td className="text-xs">
                  {r.actor_id
                    ? profiles[r.actor_id]?.full_name || profiles[r.actor_id]?.email || r.actor_id.slice(0, 8)
                    : 'system'}
                </Td>
                <Td><Badge tone={actionTones[r.action] ?? 'slate'}>{r.action}</Badge></Td>
                <Td className="text-xs">
                  {r.entity}
                  <span className="text-slate-400"> {r.entity_id?.slice(0, 8)}</span>
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
