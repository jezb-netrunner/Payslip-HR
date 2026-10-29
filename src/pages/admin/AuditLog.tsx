import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, Printer } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { AuditLog as AuditRow } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDateTime } from '../../lib/format'
import { addDays, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { downloadBlob, downloadCsv } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { logActivity } from '../../lib/activity'
import { useReportStamp } from '../../lib/useReportStamp'
import { makeStamp, stampFooter, stampRows } from '../../lib/reportStamp'
import { manilaDateTime } from '../../lib/backup'
import { buildXlsx } from '../../lib/xlsx'

const ACTIONS: Record<string, { label: string; tone: string }> = {
  insert: { label: 'added', tone: 'green' },
  update: { label: 'changed', tone: 'amber' },
  delete: { label: 'deleted', tone: 'red' },
  void: { label: 'voided', tone: 'red' },
  sign_in: { label: 'signed in', tone: 'green' },
  sign_in_failed: { label: 'failed sign-in', tone: 'amber' },
  sign_in_locked: { label: 'locked out', tone: 'red' },
  password_change: { label: 'password changed', tone: 'violet' },
  sign_out: { label: 'signed out', tone: 'slate' },
  report: { label: 'ran report', tone: 'blue' },
  print: { label: 'printed', tone: 'blue' },
  export: { label: 'exported', tone: 'blue' },
}

const TABLES: Record<string, string> = {
  activity: 'Sign-ins, reports and exports',
  employees: 'Employees',
  time_entries: 'Time entries',
  payroll_runs: 'Payroll runs',
  payroll_adjustments: 'Payroll adjustments',
  employee_pay_rates: 'Pay rates',
  employee_outputs: 'Outputs',
  consultants: 'Consultants',
  consultant_declarations: 'Consultant declarations',
  consultant_billings: 'Consultant billings',
  ewt_quarter_filings: 'EWT quarters filed',
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

// the screen shows the latest entries; exports and printouts take the whole range
const SHOWN = 500

function actionLabel(a: string): string {
  return ACTIONS[a]?.label ?? a.replaceAll('_', ' ')
}

/** What changed (an update), or the detail of a sign-in, report, export or void. */
function detail(r: AuditRow): string {
  const n = (r.new_data ?? {}) as Record<string, unknown>
  if (r.table_name === 'activity' || r.action === 'void') {
    return Object.entries(n)
      .filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && k !== 'user_agent')
      .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`)
      .join(' · ')
  }
  if (r.action !== 'update' || !r.old_data) return ''
  const o = r.old_data as Record<string, unknown>
  const changed = Object.keys(n).filter((k) => k !== 'updated_at' && JSON.stringify(o[k]) !== JSON.stringify(n[k]))
  return changed.join(', ')
}

export default function AuditLog() {
  const { isCompanyAdmin, profile } = useAuth()
  const { entity } = useEntity()
  const toast = useToast()
  const clientStamp = useReportStamp(entity)
  const today = todayManila()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [table, setTable] = useState('')
  const [scope, setScope] = useState<'client' | 'global'>('client')
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const query = useCallback(() => {
    let q = supabase.from('audit_logs').select('*', { count: 'exact' })
    if (scope === 'global') q = q.is('entity_id', null)
    else if (entity) q = q.eq('entity_id', entity.id)
    if (table) q = q.eq('table_name', table)
    // the days in Philippine time
    if (from) q = q.gte('created_at', `${from}T00:00:00+08:00`)
    if (to) q = q.lt('created_at', `${addDays(to, 1)}T00:00:00+08:00`)
    return q
  }, [scope, entity, table, from, to])

  const latest = useRef(0)
  useEffect(() => {
    const mine = ++latest.current
    // client scope needs a client: never fall back to an unfiltered query
    if (scope === 'client' && !entity) {
      setRows([])
      setTotal(0)
      setLoading(false)
      return
    }
    setLoading(true)
    void Promise.resolve(query().order('created_at', { ascending: false }).order('id', { ascending: false }).limit(SHOWN)).then(
      ({ data, count }) => {
        if (mine !== latest.current) return // a newer filter/client superseded this request
        setRows((data ?? []) as AuditRow[])
        setTotal(count ?? 0)
        setLoading(false)
      },
    )
  }, [query, scope, entity])

  const scopeLabel = scope === 'global' ? 'global entries (statutory tables, users, sign-ins)' : (entity?.name ?? '')
  const title = `Audit log, ${scopeLabel}, ${from || 'start'} to ${to || today}${table ? `, ${TABLES[table] ?? table}` : ''}`

  // global entries belong to no client: no client's name or TIN on them
  const stamp = (t: string) =>
    scope === 'global'
      ? makeStamp(t, { name: 'Company-wide entries (no client)', registered_address: '', tin: '', tin_branch_code: '' }, profile)
      : clientStamp(t)

  /** Every entry of the range, oldest first (the order a printed trail reads in). */
  const everything = () =>
    fetchAll<AuditRow>((a, b) => query().order('created_at').order('id').range(a, b))

  const asRow = (r: AuditRow) => [
    manilaDateTime(r.created_at),
    r.actor_email ?? (r.actor_id ? r.actor_id : 'system'),
    actionLabel(r.action),
    TABLES[r.table_name] ?? r.table_name,
    r.record_id ?? '',
    detail(r),
  ]
  const HEAD = ['When (PH time)', 'By', 'Action', 'Record type', 'Record id', 'Changed or detail']

  async function exportAs(format: 'xlsx' | 'csv') {
    setBusy(true)
    try {
      const all = await everything()
      const s = stamp(title)
      const base = `audit_log_${scope === 'global' ? 'global' : entity?.code}_${from}_${to}`
      if (format === 'csv') {
        downloadCsv(`${base}.csv`, [HEAD, ...all.map(asRow)], s)
      } else {
        const bytes = buildXlsx(
          [
            {
              name: 'Audit log',
              heading: stampRows(s),
              columns: [
                { header: HEAD[0], width: 17 },
                { header: HEAD[1], width: 26 },
                { header: HEAD[2], width: 16 },
                { header: HEAD[3], width: 24 },
                { header: HEAD[4], width: 38 },
                { header: HEAD[5], width: 60 },
              ],
              rows: all.map(asRow),
            },
          ],
          { title, creator: s.generatedBy },
        )
        downloadBlob(`${base}.xlsx`, new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
        void logActivity('export', scope === 'global' ? null : (entity?.id ?? null), { report: title, file: `${base}.xlsx`, rows: all.length })
      }
    } catch (err) {
      toast('error', errorMessage(err, 'Could not export the audit log'))
    } finally {
      setBusy(false)
    }
  }

  async function print() {
    const w = window.open('', '_blank', 'width=1000,height=900')
    if (!w) return
    setBusy(true)
    try {
      const all = await everything()
      const s = stamp(title)
      const esc = (v: string) =>
        v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
      const body = all
        .map((r) => `<tr>${asRow(r).map((v) => `<td>${esc(String(v))}</td>`).join('')}</tr>`)
        .join('')
      w.document.write(
        `<html><head><title>${esc(title)}</title><style>
          body{font-family:sans-serif;padding:20px;color:#0f172a;font-size:11px}
          table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e2e8f0;padding:3px 4px;text-align:left;vertical-align:top}
          th{background:#f1f5f9}td:nth-child(5){font-family:monospace;font-size:9px}
        </style></head><body>
        <p style="margin:0;font-weight:bold;font-size:13px">${esc(s.company)}</p>
        <p style="margin:2px 0">${esc([s.address, s.tinLine].filter(Boolean).join(' · '))}</p>
        <h2 style="margin:10px 0 4px;font-size:15px">${esc(title)}</h2>
        <p style="margin:0 0 10px;color:#64748b">${esc(stampFooter(s))} · ${all.length} entries</p>
        <table><thead><tr>${HEAD.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
        </body></html>`,
      )
      w.document.close()
      w.print()
      void logActivity('print', scope === 'global' ? null : (entity?.id ?? null), { report: title, rows: all.length })
    } catch (err) {
      w.close()
      toast('error', errorMessage(err, 'Could not print the audit log'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="The trail of changes, sign-ins, reports and exports, recorded by the database: nobody can edit or delete it."
        actions={
          <>
            <Button variant="secondary" disabled={busy || total === 0} onClick={() => exportAs('xlsx')}>
              <FileSpreadsheet className="size-4" /> Excel
            </Button>
            <Button variant="secondary" disabled={busy || total === 0} onClick={() => exportAs('csv')}>
              <Download className="size-4" /> CSV
            </Button>
            <Button variant="secondary" disabled={busy || total === 0} onClick={print}>
              <Printer className="size-4" /> Print
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {isCompanyAdmin && (
          <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value as 'client' | 'global')} className="w-56">
            <option value="client">{entity ? `Client: ${entity.code}` : 'Selected client'}</option>
            <option value="global">Global (statutory, users, sign-ins)</option>
          </Select>
        )}
        <Select aria-label="Record type" value={table} onChange={(e) => setTable(e.target.value)} className="w-56">
          <option value="">All record types</option>
          {Object.entries(TABLES).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
        <label className="text-xs font-medium text-slate-500">
          From
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-40" />
        </label>
        <label className="text-xs font-medium text-slate-500">
          To
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1 w-40" />
        </label>
        {!loading && (
          <p className="pb-2 text-xs text-slate-500">
            {total > rows.length ? `Showing the latest ${rows.length} of ${total} entries: export or print for all of them.` : `${total} entries`}
          </p>
        )}
      </div>
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card><EmptyState title="No audit entries" sub="Nothing recorded for these filters." /></Card>
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Record</Th>
              <Th>Changed or detail</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</Td>
                <Td className="text-xs">{r.actor_email ?? (r.actor_id ? r.actor_id.slice(0, 8) : 'system')}</Td>
                <Td><Badge tone={ACTIONS[r.action]?.tone ?? 'slate'}>{actionLabel(r.action)}</Badge></Td>
                <Td className="text-xs">
                  {TABLES[r.table_name] ?? r.table_name}
                  <span className="text-slate-400"> {r.record_id?.slice(0, 8)}</span>
                </Td>
                <Td className="max-w-md truncate text-xs text-slate-500">
                  <span title={detail(r)}>{detail(r)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
