import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, Download, FileText, Landmark, Lightbulb, ListOrdered, Pencil, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, LoadFailed, Modal, NoClient, PageHeader, Select, Spinner, StatCard, TableShell, Tabs, Td, Th, StatGroup } from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fetchAll } from '../../lib/fetchAll'
import type { Entity, Payslip, TaxRemittance } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtMonth, fmtTin, fullName, money, plural } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import Form2316Modal from '../../components/Form2316Modal'
import { alphalistCsv, type AlphalistRow } from '../../payroll/alphalist'
import { loadAlphalist } from '../../payroll/alphalistData'
import { refundDeadline, yearRemittanceSchedule, type RemittanceRow } from '../../payroll/remittance'
import { fetchRemittanceSlips } from '../../payroll/service'
import { round2 } from '../../payroll/types'
import { errorMessage } from '../../lib/errors'
import DueDates from './DueDates'
import Insights from './Insights'

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))

export default function Reports() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  // management reports first
  const [tab, setTab] = useState('insights')
  const [year, setYear] = useState(() => {
    const t = todayManila()
    // January: last year's 1604-C is what's due
    return Number(t.slice(0, 4)) - (t.slice(5, 7) === '01' ? 1 : 0)
  })
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  const thisYear = Number(todayManila().slice(0, 4))
  return (
    <div>
      <PageHeader
        title="BIR & Reports"
        subtitle={`${entity.name} · TIN ${fmtTin(entity.tin, entity.tin_branch_code) || 'not set'} · RDO ${entity.rdo_code || '—'}`}
        actions={
          tab !== 'insights' && (
            <Select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
              {Array.from({ length: 6 }, (_, i) => thisYear - 5 + i).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          )
        }
      />
      <Tabs
        tabs={[
          { key: 'insights', label: 'Insights', icon: <Lightbulb /> },
          { key: 'alphalist', label: 'Alphalist (1604-C schedules)', icon: <ListOrdered /> },
          { key: '1604c', label: '1604-C summary', icon: <FileText /> },
          { key: '1601c', label: '1601-C remittances', icon: <Landmark /> },
          { key: 'due', label: 'Due dates', icon: <CalendarClock /> },
          { key: 'contrib', label: 'SSS / PhilHealth / Pag-IBIG', icon: <ShieldCheck /> },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'insights' && <Insights key={entity.id} entity={entity} />}
      {tab === 'alphalist' && <Alphalist key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === '1604c' && <Summary1604C key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === '1601c' && <Remittances key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === 'due' && <DueDates key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === 'contrib' && <Contributions key={`${entity.id}${year}`} entity={entity} year={year} />}
    </div>
  )
}

// ---------- shared year data ----------

function useAlphalist(entity: Entity, year: number) {
  const [rows, setRows] = useState<AlphalistRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loadAlphalist(entity, year)
      .then((r) => {
        if (!cancelled) setRows(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load'))
      })
    return () => {
      cancelled = true
    }
  }, [entity, year])

  return { rows, error }
}

/**
 * The year's 1601-C months: tax withheld and paid by the employer, less
 * year-end refunds, which a month that can't absorb them carries into the
 * next months, from last year too (spec T8).
 */
function useRemittanceSchedule(entity: Entity, year: number) {
  const [state, setState] = useState<{ rows: RemittanceRow[] | null; error: string }>({ rows: null, error: '' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetchRemittanceSlips(entity.id, `${year - 1}-01-01`, `${year}-12-31`)
      .then((slips) => {
        if (!cancelled) setState({ rows: yearRemittanceSchedule(slips, year), error: '' })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(err, 'Failed to load the payroll tax by month') }))
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, year, version])
  return { ...state, reload: () => setVersion((v) => v + 1) }
}

// ---------- alphalist ----------

function Alphalist({ entity, year }: { entity: Entity; year: number }) {
  const { rows, error } = useAlphalist(entity, year)
  const [viewing, setViewing] = useState<AlphalistRow | null>(null)
  if (error) return <Card><p className="text-sm text-rose-600">{error}</p></Card>
  if (!rows) return <Spinner />
  if (rows.length === 0)
    return (
      <Card>
        <EmptyState title={`No finalized payslips for ${year}`} sub="The alphalist is built from finalized payslips paid (pay date) within the year." />
      </Card>
    )

  const sum = (f: (r: AlphalistRow) => number) => rows.reduce((s, r) => s + f(r), 0)
  // until the year's last payroll is annualized, withheld vs due differs by design
  const inProgress = todayManila() <= `${year}-12-31`
  const problems = (r: AlphalistRow) => (inProgress || !r.withholdingGap ? r.issues : [...r.issues, r.withholdingGap])
  const withIssues = rows.filter((r) => problems(r).length > 0)
  const gaps = inProgress ? rows.filter((r) => r.withholdingGap) : []

  return (
    <div className="space-y-6">
      <StatGroup>
        <StatCard label="Employees" value={rows.length} sub={`${rows.filter((r) => r.schedule === 1).length} on Schedule 1 · ${rows.filter((r) => r.schedule === 2).length} MWE on Schedule 2`} />
        <StatCard label="Gross compensation" value={money(sum((r) => r.summary.gross))} />
        <StatCard label="Tax due (annual)" value={money(sum((r) => r.summary.taxDue))} />
        <StatCard
          label="Withheld as adjusted"
          value={money(sum((r) => r.summary.withheldAsAdjusted + r.summary.prevTaxWithheld))}
          sub={withIssues.length ? `${plural(withIssues.length, 'employee')} need${withIssues.length === 1 ? 's' : ''} attention` : 'all reconciled'}
          tone={withIssues.length ? 'warn' : 'good'}
        />
      </StatGroup>

      {inProgress && (
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 text-xs text-brand-800">
          <p className="font-bold">{year} is still in progress — these are year-to-date figures.</p>
          <p className="mt-1">
            Withheld and due tax only reconcile once the last payroll paid in December (or an employee's final pay)
            is run with annualization.
            {gaps.length > 0 && ` Currently ${plural(gaps.length, 'employee')} would need an adjustment if the year ended today.`}
          </p>
        </div>
      )}

      {withIssues.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-amber-800">
            <AlertTriangle className="size-4" /> Fix before filing
          </p>
          {withIssues.map((r) => (
            <p key={r.employee.id} className="text-xs text-amber-700">
              • {fullName(r.employee)}: {problems(r).join('; ')}
            </p>
          ))}
          <p className="mt-2 text-[11px] text-amber-700">
            Withholding gaps are settled by an annualizing payroll run (last payroll of the year, or final pay) —
            then rebuild this report.
          </p>
        </div>
      )}

      {([1, 2] as const).map((schedule) => {
        const list = rows.filter((r) => r.schedule === schedule)
        return (
          <Card
            key={schedule}
            title={schedule === 1 ? 'Schedule 1 — Alphalist of Employees' : 'Schedule 2 — Alphalist of Minimum Wage Earners'}
            actions={
              <Button variant="secondary" disabled={list.length === 0} onClick={() => downloadCsv(`alphalist_${entity.code}_${year}_schedule${schedule}.csv`, alphalistCsv(rows, schedule))}>
                <Download className="size-4" /> CSV
              </Button>
            }
          >
            {list.length === 0 ? (
              <p className="text-sm text-slate-400">No employees on this schedule.</p>
            ) : (
              <TableShell>
                <thead className="bg-slate-50">
                  <tr>
                    <Th>Employee</Th>
                    <Th>Employed</Th>
                    <Th className="text-right">Gross</Th>
                    <Th className="text-right">Non-taxable</Th>
                    <Th className="text-right">Taxable</Th>
                    <Th className="text-right">Tax due</Th>
                    <Th className="text-right">Withheld</Th>
                    <Th className="text-right">Balance</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((r) => (
                    <tr key={r.employee.id} className="hover:bg-slate-50">
                      <Td>
                        <p className="font-semibold">{r.employee.last_name}, {r.employee.first_name}</p>
                        <p className="text-xs text-slate-400">
                          TIN {r.employee.tin || '—'} · {r.statusCode}
                          {r.separationCode && ` · separated (${r.separationCode})`}
                          {r.substitutedFiling && ' · substituted filing'}
                        </p>
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{fmtDate(r.from)} – {fmtDate(r.to)}</Td>
                      <Td className="text-right">{money(r.summary.gross)}</Td>
                      <Td className="text-right">{money(r.summary.totalNonTaxable)}</Td>
                      <Td className="text-right">{money(r.summary.totalTaxablePresent)}</Td>
                      <Td className="text-right">{money(r.summary.taxDue)}</Td>
                      <Td className="text-right">{money(r.summary.withheldAsAdjusted + r.summary.prevTaxWithheld)}</Td>
                      <Td className={`text-right font-semibold ${r.summary.variance === 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {money(r.summary.variance)}
                      </Td>
                      <Td>
                        <button onClick={() => setViewing(r)} className="flex items-center gap-1 text-xs font-semibold text-brand-600">
                          <FileText className="size-3.5" /> 2316
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>
        )
      })}
      <p className="text-[11px] text-slate-400">
        Layout follows the 1604-C alphalist (RMC 73-2019): Schedule 1 employees, Schedule 2 minimum
        wage earners, each figure as declared on BIR Form 2316. Key or import the CSV figures into the BIR Alphalist
        Data Entry and Validation Module (it generates the DAT file for eSubmission). Balance = tax due − tax withheld.
      </p>

      {viewing && <Form2316Modal row={viewing} entity={entity} year={year} onClose={() => setViewing(null)} />}
    </div>
  )
}

// ---------- 1604-C summary ----------

function Summary1604C({ entity, year }: { entity: Entity; year: number }) {
  const { rows, error: alphaError } = useAlphalist(entity, year)
  const schedule = useRemittanceSchedule(entity, year)
  const [remits, setRemits] = useState<TaxRemittance[]>([])
  const [remitError, setRemitError] = useState('')

  useEffect(() => {
    supabase
      .from('tax_remittances')
      .select('*')
      .eq('entity_id', entity.id)
      .gte('period_month', `${year}-01-01`)
      .lte('period_month', `${year}-12-01`)
      .then(({ data, error: err }) => {
        // a failed read must not show every month as "not recorded"
        if (err) setRemitError(errorMessage(err, 'Failed to load the 1601-C remittances'))
        else setRemits((data ?? []) as TaxRemittance[])
      })
  }, [entity.id, year])
  const error = alphaError || remitError || schedule.error

  if (error) return <Card><p className="text-sm text-rose-600">{error}</p></Card>
  if (!rows || !schedule.rows) return <Spinner />

  // what each month's payroll leaves to remit: withheld + paid by the employer − refunds recovered
  const months = MONTHS.map((mm, i) => {
    const r = remits.find((x) => x.period_month.slice(5, 7) === mm)
    return { mm, payroll: schedule.rows![i].due, r }
  })
  const totals = {
    payroll: months.reduce((s, m) => s + m.payroll, 0),
    withheld: months.reduce((s, m) => s + Number(m.r?.taxes_withheld ?? 0), 0),
    adjustment: months.reduce((s, m) => s + Number(m.r?.adjustment ?? 0), 0),
    penalties: months.reduce((s, m) => s + Number(m.r?.penalties ?? 0), 0),
    total: months.reduce((s, m) => s + Number(m.r?.total_remitted ?? 0), 0),
  }
  const list = rows
  const sum = (f: (r: AlphalistRow) => number) => list.reduce((s, r) => s + f(r), 0)

  const header: [string, string][] = [
    ['For the year', String(year)],
    ['TIN', fmtTin(entity.tin, entity.tin_branch_code)],
    ['RDO code', entity.rdo_code],
    ["Withholding agent's name", entity.name],
    ['Registered address', entity.registered_address],
    ['ZIP code', entity.zip_code],
    ['Category of withholding agent', entity.withholding_agent_category === 'government' ? 'Government' : 'Private'],
    ['Top withholding agent', entity.is_top_withholding_agent ? 'Yes' : 'No'],
    ['Contact number', entity.contact_number],
    ['Email address', entity.contact_email],
  ]

  function exportCsv() {
    const out: (string | number)[][] = [['BIR Form 1604-C working summary'], ...header.map(([k, v]) => [k, v]), []]
    out.push(['Month', 'To remit per payroll', 'Date of remittance', 'Drawee bank / agency', 'TRA / eROR / eAR no.', 'Taxes withheld', 'Adjustment', 'Penalties', 'Total amount remitted'])
    for (const m of months) {
      out.push([
        fmtMonth(`${year}-${m.mm}-01`), m.payroll, m.r?.date_paid ?? '', m.r?.bank_or_agency ?? '', m.r?.reference_no ?? '',
        Number(m.r?.taxes_withheld ?? 0), Number(m.r?.adjustment ?? 0), Number(m.r?.penalties ?? 0), Number(m.r?.total_remitted ?? 0),
      ])
    }
    out.push(['TOTAL', totals.payroll, '', '', '', totals.withheld, totals.adjustment, totals.penalties, totals.total])
    out.push([])
    out.push(['Employees in alphalist', list.length])
    out.push(['Total gross compensation', sum((r) => r.summary.gross)])
    out.push(['Total non-taxable compensation', sum((r) => r.summary.totalNonTaxable)])
    out.push(['Total taxable compensation', sum((r) => r.summary.totalTaxablePresent)])
    out.push(['Total tax due', sum((r) => r.summary.taxDue)])
    out.push(['Total tax withheld (present employer, as adjusted)', sum((r) => r.summary.withheldAsAdjusted)])
    downloadCsv(`1604C_${entity.code}_${year}.csv`, out)
  }

  const missing = header.filter(([k, v]) => !v && !['Contact number', 'Email address'].includes(k))

  return (
    <div className="space-y-6">
      <Card
        title={`BIR Form 1604-C — ${year} (due January 31, ${year + 1})`}
        actions={
          <Button variant="secondary" onClick={exportCsv}>
            <Download className="size-4" /> CSV
          </Button>
        }
      >
        {missing.length > 0 && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Missing in Client Settings: {missing.map(([k]) => k).join(', ')}.
          </p>
        )}
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {header.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-slate-50 py-1">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-semibold text-slate-700">{v || '—'}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Part II — Summary of remittances per BIR Form 1601-C" icon={<Landmark />}>
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Month</Th>
              <Th className="text-right">To remit per payroll</Th>
              <Th>Date remitted</Th>
              <Th>Bank / agency · reference</Th>
              <Th className="text-right">Taxes withheld</Th>
              <Th className="text-right">Adj.</Th>
              <Th className="text-right">Penalties</Th>
              <Th className="text-right">Total remitted</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {months.map((m) => {
              const mismatch = m.r ? Math.abs(Number(m.r.taxes_withheld) + Number(m.r.adjustment) - m.payroll) > 0.005 : m.payroll > 0
              return (
                <tr key={m.mm}>
                  <Td className="font-semibold">{fmtMonth(`${year}-${m.mm}-01`)}</Td>
                  <Td className={`text-right ${mismatch ? 'text-amber-600' : ''}`}>{money(m.payroll)}</Td>
                  <Td className="text-xs">{m.r?.date_paid ? fmtDate(m.r.date_paid) : m.payroll > 0 ? <Badge tone="amber">not recorded</Badge> : '—'}</Td>
                  <Td className="text-xs">{m.r ? `${m.r.bank_or_agency || '—'} · ${m.r.reference_no || '—'}` : ''}</Td>
                  <Td className="text-right">{m.r ? money(Number(m.r.taxes_withheld)) : ''}</Td>
                  <Td className="text-right">{m.r ? money(Number(m.r.adjustment)) : ''}</Td>
                  <Td className="text-right">{m.r ? money(Number(m.r.penalties)) : ''}</Td>
                  <Td className="text-right font-semibold">{m.r ? money(Number(m.r.total_remitted)) : ''}</Td>
                </tr>
              )
            })}
            <tr className="bg-slate-50 font-bold">
              <Td>Total</Td>
              <Td className="text-right">{money(totals.payroll)}</Td>
              <Td></Td>
              <Td></Td>
              <Td className="text-right">{money(totals.withheld)}</Td>
              <Td className="text-right">{money(totals.adjustment)}</Td>
              <Td className="text-right">{money(totals.penalties)}</Td>
              <Td className="text-right">{money(totals.total)}</Td>
            </tr>
          </tbody>
        </TableShell>
        <p className="mt-3 text-[11px] text-slate-400">
          "To remit per payroll" is the tax withheld on finalized payslips by the month they were paid (pay date), plus tax the employer
          paid at a year-end adjustment, less year-end refunds (a refund the month can't absorb is recovered from the next months).
          Record each monthly 1601-C payment under 1601-C remittances. Amber = payroll and remittance (taxes withheld + adjustment) differ.
        </p>
      </Card>

      <Card title="Alphalist totals" icon={<ListOrdered />}>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <p>Employees: <b>{rows.length}</b> ({rows.filter((r) => r.schedule === 2).length} MWE)</p>
          <p>Gross compensation: <b>{money(sum((r) => r.summary.gross))}</b></p>
          <p>Taxable compensation: <b>{money(sum((r) => r.summary.totalTaxablePresent))}</b></p>
          <p>Tax due: <b>{money(sum((r) => r.summary.taxDue))}</b></p>
          <p>Withheld (as adjusted): <b>{money(sum((r) => r.summary.withheldAsAdjusted))}</b></p>
          <p>Unreconciled employees: <b>{rows.filter((r) => r.summary.variance !== 0).length}</b></p>
        </div>
      </Card>
    </div>
  )
}

// ---------- 1601-C remittance records ----------

function Remittances({ entity, year }: { entity: Entity; year: number }) {
  const toast = useToast()
  const schedule = useRemittanceSchedule(entity, year)
  const [remits, setRemits] = useState<TaxRemittance[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<Partial<TaxRemittance> & { period_month: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const { data, error } = await supabase
        .from('tax_remittances')
        .select('*')
        .eq('entity_id', entity.id)
        .gte('period_month', `${year}-01-01`)
        .lte('period_month', `${year}-12-01`)
      if (error) throw error
      setRemits((data ?? []) as TaxRemittance[])
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load'))
    } finally {
      setLoading(false)
    }
  }, [entity.id, year])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    if (!editing) return
    const payload = {
      entity_id: entity.id,
      period_month: editing.period_month,
      date_paid: editing.date_paid || null,
      bank_or_agency: editing.bank_or_agency ?? '',
      reference_no: editing.reference_no ?? '',
      taxes_withheld: Number(editing.taxes_withheld ?? 0),
      adjustment: Number(editing.adjustment ?? 0),
      penalties: Number(editing.penalties ?? 0),
      remarks: editing.remarks ?? '',
    }
    const { error } = await supabase.from('tax_remittances').upsert(payload, { onConflict: 'entity_id,period_month' })
    if (error) toast('error', errorMessage(error, 'Save failed'))
    else {
      toast('success', '1601-C remittance saved (audit-logged).')
      setEditing(null)
      await load()
    }
  }

  const error = loadError || schedule.error
  if (error) return <LoadFailed message={error} onRetry={() => { load(); schedule.reload() }} />
  if (loading || !schedule.rows) return <Spinner />
  const months = schedule.rows
  const carriedIn = months[0].carriedIn
  const carryOut = months[11].carryOut
  return (
    <Card title={`Monthly BIR Form 1601-C remittances — ${year}`} icon={<Landmark />}>
      <TableShell>
        <thead className="bg-slate-50">
          <tr>
            <Th>Month</Th>
            <Th className="text-right">Withheld</Th>
            <Th className="text-right">Paid by employer</Th>
            <Th className="text-right">Refunds recovered</Th>
            <Th className="text-right">To remit</Th>
            <Th>Date remitted</Th>
            <Th>Reference</Th>
            <Th className="text-right">Total remitted</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {months.map((m) => {
            const r = remits.find((x) => x.period_month === m.month)
            return (
              <tr key={m.month} className="hover:bg-slate-50">
                <Td className="font-semibold">{fmtMonth(m.month)}</Td>
                <Td className="text-right">{money(m.withheld)}</Td>
                <Td className="text-right">{m.employerPaid ? money(m.employerPaid) : '—'}</Td>
                <Td className="text-right">
                  {m.recovered ? `(${money(m.recovered)})` : '—'}
                  {m.carryOut > 0 && <span className="block text-[11px] text-amber-600">{money(m.carryOut)} still to recover</span>}
                </Td>
                <Td className="text-right font-semibold">{money(m.due)}</Td>
                <Td className="text-xs">{r?.date_paid ? fmtDate(r.date_paid) : '—'}</Td>
                <Td className="text-xs">{r ? `${r.bank_or_agency || '—'} · ${r.reference_no || '—'}` : '—'}</Td>
                <Td className="text-right font-semibold">{r ? money(Number(r.total_remitted)) : '—'}</Td>
                <Td>
                  <button
                    onClick={() =>
                      setEditing(
                        r
                          ? { ...r }
                          : { period_month: m.month, taxes_withheld: round2(m.withheld + m.employerPaid), adjustment: m.recovered ? -m.recovered : 0, penalties: 0 },
                      )
                    }
                    className="flex items-center gap-1 text-xs font-semibold text-brand-600"
                  >
                    <Pencil className="size-3.5" /> {r ? 'Edit' : 'Record'}
                  </button>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </TableShell>
      <div className="mt-3 space-y-1 text-[11px] text-slate-400">
        <p>1601-C is filed and paid monthly (eFPS/eBIRForms); these records feed Part II of the 1604-C.</p>
        <p>
          Year-end refunds are paid to employees by {fmtDate(refundDeadline(year))} at the latest and recovered from the remittance of the
          month they were paid; what that month can't absorb is recovered from the following months. Tax the employer paid because the
          year-end pay couldn't cover it is remitted with the month's withholding.
          {carriedIn > 0 && ` ${money(carriedIn)} of refunds paid in ${year - 1} carried into ${year}.`}
          {carryOut > 0 && ` ${money(carryOut)} is still to recover in ${year + 1}.`}
        </p>
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`1601-C — ${editing ? fmtMonth(editing.period_month) : ''}`}>
        {editing && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date of remittance">
                <Input type="date" value={editing.date_paid ?? ''} onChange={(e) => setEditing({ ...editing, date_paid: e.target.value })} />
              </Field>
              <Field label="Drawee bank / bank code / agency">
                <Input value={editing.bank_or_agency ?? ''} onChange={(e) => setEditing({ ...editing, bank_or_agency: e.target.value })} />
              </Field>
              <Field label="TRA / eROR / eAR number" className="col-span-2">
                <Input value={editing.reference_no ?? ''} onChange={(e) => setEditing({ ...editing, reference_no: e.target.value })} />
              </Field>
              <Field label="Taxes withheld">
                <Input type="number" step="0.01" value={String(editing.taxes_withheld ?? 0)} onChange={(e) => setEditing({ ...editing, taxes_withheld: e.target.value as unknown as number })} />
              </Field>
              <Field label="Adjustment (refunds recovered: negative)">
                <Input type="number" step="0.01" value={String(editing.adjustment ?? 0)} onChange={(e) => setEditing({ ...editing, adjustment: e.target.value as unknown as number })} />
              </Field>
              <Field label="Penalties">
                <Input type="number" step="0.01" value={String(editing.penalties ?? 0)} onChange={(e) => setEditing({ ...editing, penalties: e.target.value as unknown as number })} />
              </Field>
              <Field label="Remarks">
                <Input value={editing.remarks ?? ''} onChange={(e) => setEditing({ ...editing, remarks: e.target.value })} />
              </Field>
            </div>
            <Button className="w-full" onClick={save}>Save</Button>
          </div>
        )}
      </Modal>
    </Card>
  )
}

// ---------- monthly contributions ----------

type ContribSlip = Pick<
  Payslip,
  'employee_id' | 'employee_snapshot' | 'sss_ee' | 'sss_mpf_ee' | 'sss_er' | 'sss_mpf_er' | 'sss_ec_er' | 'philhealth_ee' | 'philhealth_er' | 'pagibig_ee' | 'pagibig_er'
>

function Contributions({ entity, year }: { entity: Entity; year: number }) {
  const [month, setMonth] = useState(() => {
    const t = todayManila()
    return t.slice(0, 4) === String(year) ? t.slice(5, 7) : '12'
  })
  const [slips, setSlips] = useState<ContribSlip[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setSlips(null)
    setLoadError('')
    fetchAll<ContribSlip>((from, to) =>
      supabase
        .from('payslips')
        .select('employee_id, employee_snapshot, sss_ee, sss_mpf_ee, sss_er, sss_mpf_er, sss_ec_er, philhealth_ee, philhealth_er, pagibig_ee, pagibig_er, payroll_runs!inner(status)')
        .eq('entity_id', entity.id)
        .eq('period_month', `${year}-${month}-01`)
        .in('payroll_runs.status', ['finalized', 'paid'])
        .order('id')
        .range(from, to),
    )
      .then((s) => {
        if (!cancelled) setSlips(s)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, 'Failed to load'))
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, year, month, reload])

  const rows = useMemo(() => {
    const m = new Map<string, { name: string; no: string; sss: string; ph: string; hdmf: string; v: number[] }>()
    for (const s of slips ?? []) {
      const snap = s.employee_snapshot as Record<string, string>
      const cur = m.get(s.employee_id) ?? { name: snap.name, no: snap.employee_no, sss: snap.sss_no ?? '', ph: snap.philhealth_no ?? '', hdmf: snap.pagibig_no ?? '', v: [0, 0, 0, 0, 0, 0, 0, 0] }
      const add = [
        Number(s.sss_ee) + Number(s.sss_mpf_ee), Number(s.sss_er) + Number(s.sss_mpf_er), Number(s.sss_ec_er),
        Number(s.sss_mpf_ee) + Number(s.sss_mpf_er), Number(s.philhealth_ee), Number(s.philhealth_er), Number(s.pagibig_ee), Number(s.pagibig_er),
      ]
      cur.v = cur.v.map((x, i) => Math.round((x + add[i]) * 100) / 100)
      m.set(s.employee_id, cur)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [slips])
  const tot = rows.reduce((acc, r) => acc.map((x, i) => Math.round((x + r.v[i]) * 100) / 100), [0, 0, 0, 0, 0, 0, 0, 0])
  const cols = ['SSS EE', 'SSS ER', 'EC', 'of which MPF', 'PhilHealth EE', 'PhilHealth ER', 'Pag-IBIG EE', 'Pag-IBIG ER']

  return (
    <Card
      title={`Contributions for ${fmtMonth(`${year}-${month}-01`)} (payroll month)`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-36">
            {MONTHS.map((mm) => (
              <option key={mm} value={mm}>{fmtMonth(`${year}-${mm}-01`)}</option>
            ))}
          </Select>
          <Button
            variant="secondary"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(`contributions_${entity.code}_${year}-${month}.csv`, [
                ['Employee No', 'Employee', 'SSS No', 'PhilHealth No', 'Pag-IBIG MID', ...cols],
                ...rows.map((r) => [r.no, r.name, r.sss, r.ph, r.hdmf, ...r.v]),
                ['', 'TOTAL', '', '', '', ...tot],
              ])
            }
          >
            <Download className="size-4" /> CSV
          </Button>
        </div>
      }
    >
      {loadError ? (
        <LoadFailed message={loadError} onRetry={() => setReload((n) => n + 1)} />
      ) : !slips ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No finalized payslips for this payroll month" />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Employee</Th>
              {cols.map((c) => (
                <Th key={c} className="text-right">{c}</Th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.no + r.name}>
                <Td>
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-xs text-slate-400">SSS {r.sss || '—'} · PH {r.ph || '—'} · HDMF {r.hdmf || '—'}</p>
                </Td>
                {r.v.map((x, i) => (
                  <Td key={i} className="text-right text-xs">{money(x)}</Td>
                ))}
              </tr>
            ))}
            <tr className="bg-slate-50 font-bold">
              <Td>Total</Td>
              {tot.map((x, i) => (
                <Td key={i} className="text-right text-xs">{money(x)}</Td>
              ))}
            </tr>
          </tbody>
        </TableShell>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        Totals per employee across every payroll of the month — the amounts to report and remit for SSS (incl.
        MPF/WISP and EC), PhilHealth and Pag-IBIG.
      </p>
    </Card>
  )
}
