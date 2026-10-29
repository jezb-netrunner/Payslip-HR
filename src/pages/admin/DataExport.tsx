import { useEffect, useState } from 'react'
import { FileSpreadsheet, ShieldAlert } from 'lucide-react'
import { Button, Card, Field, NoClient, PageHeader, Select } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import { useEntity } from '../../lib/entity'
import { fetchAll } from '../../lib/fetchAll'
import { supabase } from '../../lib/supabase'
import { todayManila } from '../../lib/manila'
import { downloadBlob } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { logActivity } from '../../lib/activity'
import { useReportStamp } from '../../lib/useReportStamp'
import { BACKUP_SHEETS, backupSheets, type BackupData } from '../../lib/backup'
import { buildXlsx } from '../../lib/xlsx'
import type { Entity, PayrollVoid } from '../../lib/db'

type Range = { from: string; to: string } | null

/** Every row of a client's table, page by page; `range` limits a date column to the year. */
async function rows<T>(table: string, entityId: string, order: string[], range: Range, dateColumn?: string, select = '*'): Promise<T[]> {
  return fetchAll<T>((from, to) => {
    let q = supabase.from(table).select(select).eq('entity_id', entityId)
    if (range && dateColumn) q = q.gte(dateColumn, range.from).lte(dateColumn, range.to)
    for (const c of order) q = q.order(c)
    return q.range(from, to)
  })
}

/** The client's payroll records for the year (or every year), as the backup lays them out. */
async function loadBackup(entity: Entity, year: number | null, onStep: (label: string) => void): Promise<BackupData> {
  const id = entity.id
  const range: Range = year ? { from: `${year}-01-01`, to: `${year}-12-31` } : null
  onStep('payroll runs and payslips')
  const [runs, payslips] = await Promise.all([
    rows<BackupData['runs'][number]>('payroll_runs', id, ['pay_date', 'created_at', 'id'], range, 'pay_date'),
    rows<BackupData['payslips'][number]>('payslips', id, ['pay_date', 'control_no', 'id'], range, 'pay_date'),
  ])
  onStep('employees, pay rates and adjustments')
  const runIds = new Set(runs.map((r) => r.id))
  const [employees, payRates, adjustments] = await Promise.all([
    rows<BackupData['employees'][number]>('employees', id, ['employee_no', 'id'], null),
    rows<BackupData['payRates'][number]>('employee_pay_rates', id, ['employee_id', 'effective_from', 'id'], null),
    rows<BackupData['adjustments'][number]>('payroll_adjustments', id, ['created_at', 'id'], null),
  ])
  onStep('advances, remittances and consultants')
  const [deductions, repayments, remittances, consultants, billings, voids] = await Promise.all([
    // deductions carry no client column: the employee's client decides
    fetchAll<BackupData['deductions'][number]>((from, to) =>
      supabase.from('recurring_deductions').select('*, employees!inner(entity_id)').eq('employees.entity_id', id).order('id').range(from, to),
    ),
    rows<BackupData['repayments'][number]>('advance_repayments', id, ['paid_on', 'id'], range, 'paid_on'),
    rows<BackupData['remittances'][number]>('tax_remittances', id, ['period_month', 'id'], range, 'period_month'),
    rows<BackupData['consultants'][number]>('consultants', id, ['last_name', 'registered_name', 'id'], null),
    rows<BackupData['billings'][number]>('consultant_billings', id, ['billed_on', 'id'], range, 'billed_on'),
    rows<PayrollVoid>('payroll_voids', id, ['voided_at', 'id'], null),
  ])
  onStep('time in/out and leave')
  const [timeEntries, leaves] = await Promise.all([
    rows<BackupData['timeEntries'][number]>('time_entries', id, ['work_date', 'employee_id', 'clock_in', 'id'], range, 'work_date'),
    rows<BackupData['leaves'][number]>('leave_requests', id, ['start_date', 'id'], range, 'start_date', '*, leave_types(name)'),
  ])
  onStep('the audit log')
  const audit = await fetchAll<BackupData['audit'][number]>((from, to) => {
    let q = supabase.from('audit_logs').select('*').eq('entity_id', id)
    // the year in Philippine time
    if (year) q = q.gte('created_at', `${year}-01-01T00:00:00+08:00`).lt('created_at', `${year + 1}-01-01T00:00:00+08:00`)
    return q.order('id').range(from, to)
  })
  const inYear = (d: string | null | undefined) => !year || (d ?? '').startsWith(String(year))
  return {
    period: year ? String(year) : 'all years',
    runs,
    payslips,
    employees,
    payRates,
    adjustments: adjustments.filter((a) => !year || runIds.has(a.payroll_run_id)),
    deductions: deductions.map(({ employees: _client, ...d }: typeof deductions[number] & { employees?: unknown }) => d),
    repayments,
    remittances,
    consultants,
    billings,
    voids: voids.filter((v) => inYear(v.run_snapshot?.pay_date)),
    timeEntries,
    leaves,
    audit,
  }
}

export default function DataExport() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const toast = useToast()
  const stamp = useReportStamp(entity)
  const thisYear = Number(todayManila().slice(0, 4))
  const [year, setYear] = useState<number | null>(thisYear)
  const [firstYear, setFirstYear] = useState(thisYear)
  const [step, setStep] = useState<string | null>(null)

  // the years the client has payrolls for
  useEffect(() => {
    if (!entity) return
    let stale = false
    supabase
      .from('payroll_runs')
      .select('pay_date')
      .eq('entity_id', entity.id)
      .order('pay_date')
      .limit(1)
      .then(({ data }) => {
        const first = Number(String(data?.[0]?.pay_date ?? '').slice(0, 4))
        if (!stale && first) setFirstYear(Math.min(first, thisYear))
      })
    return () => {
      stale = true
    }
  }, [entity, thisYear])

  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />

  async function download() {
    if (!entity || step) return
    setStep('records')
    try {
      const data = await loadBackup(entity, year, setStep)
      setStep('the workbook')
      const sheets = backupSheets(data, stamp)
      const file = `payroll_backup_${entity.code}_${year ?? 'all-years'}_${todayManila()}.xlsx`
      const bytes = buildXlsx(sheets, { title: `Payroll records backup, ${data.period}`, creator: stamp('').generatedBy })
      downloadBlob(file, new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const total = sheets.reduce((t, s) => t + (s.name === 'About' ? 0 : s.rows.length), 0)
      void logActivity('export', entity.id, { report: 'Payroll records backup', period: data.period, file, rows: total })
      toast('success', `Downloaded ${file}.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Could not prepare the backup'))
    } finally {
      setStep(null)
    }
  }

  const years = Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i)
  return (
    <div>
      <PageHeader
        title="Data Export"
        subtitle={`${entity.name} · the client's payroll records as one Excel workbook, to keep on your own storage`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="Payroll records backup (Excel)" icon={<FileSpreadsheet />}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              One .xlsx file with a sheet for each kind of record. Every sheet starts with the client&apos;s registered
              name, VAT status and TIN, who generated it and when, and the software version; amounts are numbers you
              can total, and TINs and employee numbers keep their leading zeros.
            </p>
            <Field label="Records of">
              <Select
                value={year ?? ''}
                onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}
                disabled={!!step}
                className="w-48"
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y} (by pay date)</option>
                ))}
                <option value="">All years</option>
              </Select>
            </Field>
            <Button onClick={download} disabled={!!step}>
              <FileSpreadsheet className="size-4" /> {step ? `Loading ${step}…` : 'Download Excel backup'}
            </Button>
            <ul className="grid gap-x-6 gap-y-1.5 text-xs text-slate-500 sm:grid-cols-2">
              {BACKUP_SHEETS.map(([name, what]) => (
                <li key={name}>
                  <span className="font-semibold text-slate-700">{name}</span> · {what}
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <aside className="space-y-4">
          <div className="rounded-xl bg-slate-200/50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-ink-900">Keep it</p>
            <p className="mt-1">
              Download the backup after every finalized payroll or at least every month, and keep the files off this
              system: payroll records are kept for at least five years (RA 11976, RR 7-2024) and DOLE inspections ask for
              payrolls and time records.
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <p className="flex items-center gap-1.5 font-semibold">
              <ShieldAlert className="size-4" /> Personal data
            </p>
            <p className="mt-1">
              The file holds TINs, SSS, PhilHealth and Pag-IBIG numbers, birth dates and bank accounts. Store it
              encrypted or access-controlled (Data Privacy Act of 2012). Each download is on the audit log.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
