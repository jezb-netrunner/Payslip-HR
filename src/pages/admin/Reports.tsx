import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, FileText, Landmark, Lightbulb, ListOrdered, Pencil, Printer, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, LoadFailed, Modal, NoClient, PageHeader, Select, Spinner, StatCard, TableShell, Tabs, Td, Th, StatGroup } from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv, getEmployees, getStatutoryTables } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fetchAll } from '../../lib/fetchAll'
import type { Entity, Payslip, TaxRemittance } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtMonth, fmtTin, fullName, money, plural } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { alphalistCsv, buildAlphalist, type AlphalistRow, type YearEndRate } from '../../payroll/alphalist'
import { fetchFinalizedPayslipsForTaxYear, fetchTaxYears, toAnnualFact, type YearPayslip } from '../../payroll/service'
import { errorMessage } from '../../lib/errors'
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
          { key: 'contrib', label: 'SSS / PhilHealth / Pag-IBIG', icon: <ShieldCheck /> },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'insights' && <Insights key={entity.id} entity={entity} />}
      {tab === 'alphalist' && <Alphalist key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === '1604c' && <Summary1604C key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === '1601c' && <Remittances key={`${entity.id}${year}`} entity={entity} year={year} />}
      {tab === 'contrib' && <Contributions key={`${entity.id}${year}`} entity={entity} year={year} />}
    </div>
  )
}

// ---------- shared year data ----------

function useAlphalist(entity: Entity, year: number) {
  const [rows, setRows] = useState<AlphalistRow[] | null>(null)
  const [slips, setSlips] = useState<YearPayslip[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [employees, payslips, taxYears, tables, mweRates] = await Promise.all([
          getEmployees(entity.id),
          // tax year = compensation PAID in the year (pay date)
          fetchFinalizedPayslipsForTaxYear(entity.id, year),
          fetchTaxYears(entity.id, year),
          getStatutoryTables(`${year}-12-31`),
          // the rate on each minimum wage earner's payslips, latest last
          fetchAll<{ employee_id: string; pay_type: string; daily_rate: string; monthly_rate: string }>((from, to) =>
            supabase
              .from('payslips')
              .select(
                'employee_id, pay_type:employee_snapshot->>pay_type, daily_rate:employee_snapshot->>daily_rate, monthly_rate:employee_snapshot->>monthly_rate, payroll_runs!inner(status)',
              )
              .eq('entity_id', entity.id)
              .eq('is_minimum_wage_earner', true)
              .neq('run_type', 'thirteenth_month')
              .in('payroll_runs.status', ['finalized', 'paid'])
              .gte('pay_date', `${year}-01-01`)
              .lte('pay_date', `${year}-12-31`)
              .order('period_end')
              .order('id')
              .range(from, to),
          ),
        ])
        if (cancelled) return
        const yearEndRates = new Map<string, YearEndRate>()
        for (const r of mweRates) {
          yearEndRates.set(r.employee_id, {
            payType: r.pay_type === 'monthly' ? 'monthly' : 'daily',
            daily: Number(r.daily_rate) || 0,
            monthly: Number(r.monthly_rate) || 0,
          })
        }
        setSlips(payslips)
        setRows(
          buildAlphalist({
            year,
            entity,
            employees,
            payslips: payslips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })),
            taxYears,
            annual: tables.bir_annual,
            yearEndRates,
          }),
        )
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Failed to load'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entity, year])

  return { rows, slips, error }
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

function Form2316Modal({ row, entity, year, onClose }: { row: AlphalistRow; entity: Entity; year: number; onClose: () => void }) {
  const s = row.summary
  const e = row.employee
  const groups: [string, [string, number | string][]][] = [
    [
      'Part IV-A — Summary',
      [
        ['Gross compensation income from present employer', s.gross],
        ['Less: total non-taxable / exempt compensation (present employer)', s.totalNonTaxable],
        ['Taxable compensation income from present employer', s.totalTaxablePresent],
        ['Add: taxable compensation income from previous employer', s.prevTaxable],
        ['Gross taxable compensation income', s.totalTaxable],
        ['Tax due', s.taxDue],
        ['Taxes withheld — present employer (as adjusted)', s.withheldAsAdjusted],
        ['Taxes withheld — previous employer', s.prevTaxWithheld],
        ['Total amount of taxes withheld as adjusted', s.withheldAsAdjusted + s.prevTaxWithheld],
        ['5% tax credit (PERA Act of 2008)', s.peraCredit],
        ['Total taxes withheld', s.withheldAsAdjusted + s.prevTaxWithheld + s.peraCredit],
      ],
    ],
    [
      'Part IV-B — Non-taxable / exempt compensation',
      [
        ['Basic salary / statutory minimum wage (MWE)', s.mweBasic],
        ['Holiday pay (MWE)', s.mweHoliday],
        ['Overtime pay (MWE)', s.mweOvertime],
        ['Night shift differential (MWE)', s.mweNightDiff],
        ['Hazard pay (MWE)', s.mweHazard],
        ['13th month pay and other benefits', s.thirteenthOtherBenefitsExempt],
        ['De minimis benefits', s.deMinimis],
        ['SSS, GSIS, PHIC & Pag-IBIG contributions and union dues (employee share)', s.contributions],
        ['Salaries and other forms of compensation', s.otherNonTaxable],
        ['Total non-taxable / exempt compensation', s.totalNonTaxable],
      ],
    ],
    [
      'Part IV-B — Taxable compensation',
      [
        ['Basic salary', s.taxableBasic],
        ['Representation', s.taxableRepresentation],
        ['Transportation', s.taxableTransportation],
        ['Cost of living allowance (COLA)', s.taxableCola],
        ['Fixed housing allowance', s.taxableHousing],
        ['Others (regular)', s.taxableOtherRegular],
        ['Taxable 13th month benefits and other benefits', s.taxable13thOtherBenefits],
        ['Hazard pay', s.taxableHazard],
        ['Overtime pay', s.taxableOvertime],
        ['Others (supplementary: holiday/premium pay, night differential)', s.taxableOtherSupplementary],
        ['Total taxable compensation (present employer)', s.totalTaxablePresent],
      ],
    ],
  ]

  function print() {
    const w = window.open('', '_blank', 'width=760,height=900')
    if (!w) return
    const esc = (v: string) =>
      v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    const val = (v: number | string) => (typeof v === 'number' ? v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(v))
    const sections = groups
      .map(
        ([title, items]) =>
          `<h3 style="margin:18px 0 6px;font-size:13px">${esc(title)}</h3><table style="width:100%;border-collapse:collapse;font-size:12px">${items
            .map(([k, v]) => `<tr><td style="padding:3px 0;border-bottom:1px solid #e2e8f0">${esc(k)}</td><td style="text-align:right;border-bottom:1px solid #e2e8f0">${val(v)}</td></tr>`)
            .join('')}</table>`,
      )
      .join('')
    w.document.write(
      `<html><head><title>BIR 2316 data — ${esc(fullName(e))}</title></head><body style="font-family:sans-serif;padding:24px;color:#0f172a">
      <h2 style="margin:0">BIR Form 2316 figures — ${year}</h2>
      <p style="font-size:12px;color:#475569">Working figures for the official BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld).</p>
      <p style="font-size:12px"><b>Employee:</b> ${esc(`${e.last_name}, ${e.first_name} ${e.middle_name ?? ''}`)} · TIN ${esc(e.tin ?? '—')} · Born ${esc(e.birth_date ?? '—')}<br/>
      <b>Address:</b> ${esc(e.address ?? '—')} ${esc(e.zip_code ?? '')} · <b>Period:</b> ${esc(row.from)} to ${esc(row.to)}${row.schedule === 2 ? ` · <b>MWE</b> ${esc(row.region)} SMW ₱${val(row.smwPerDay)}/day` : ''}<br/>
      <b>Employer:</b> ${esc(entity.name)} · TIN ${esc(fmtTin(entity.tin, entity.tin_branch_code))} · ${esc(entity.registered_address)} ${esc(entity.zip_code)}
      ${row.prevEmployerTin ? `<br/><b>Previous employer:</b> ${esc(row.prevEmployerName)} · TIN ${esc(row.prevEmployerTin)}` : ''}</p>
      ${sections}</body></html>`,
    )
    w.document.close()
    w.print()
  }

  return (
    <Modal open onClose={onClose} title={`BIR 2316 figures — ${fullName(e)} (${year})`} wide>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          {e.last_name}, {e.first_name} · TIN {e.tin || '—'} · {fmtDate(row.from)} – {fmtDate(row.to)}
          {row.schedule === 2 && ` · MWE (${row.region}) ₱${row.smwPerDay}/day × ${row.factor} days`}
        </p>
        {groups.map(([title, items]) => (
          <div key={title}>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-4">
              {items.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-1.5 text-sm">
                  <span className="text-slate-600">{k}</span>
                  <span className="font-semibold text-slate-800">{typeof v === 'number' ? money(v) : v}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={print}>
          <Printer className="size-4" /> Print
        </Button>
      </div>
    </Modal>
  )
}

// ---------- 1604-C summary ----------

function Summary1604C({ entity, year }: { entity: Entity; year: number }) {
  const { rows, slips, error: alphaError } = useAlphalist(entity, year)
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
  const error = alphaError || remitError

  const withheldByMonth = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of slips) {
      const k = (s.pay_date ?? '').slice(5, 7)
      m[k] = (m[k] ?? 0) + Number(s.withholding_tax)
    }
    return m
  }, [slips])

  if (error) return <Card><p className="text-sm text-rose-600">{error}</p></Card>
  if (!rows) return <Spinner />

  const months = MONTHS.map((mm) => {
    const r = remits.find((x) => x.period_month.slice(5, 7) === mm)
    return { mm, payroll: Math.round((withheldByMonth[mm] ?? 0) * 100) / 100, r }
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
    out.push(['Month', 'Withheld per payroll', 'Date of remittance', 'Drawee bank / agency', 'TRA / eROR / eAR no.', 'Taxes withheld', 'Adjustment', 'Penalties', 'Total amount remitted'])
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
              <Th className="text-right">Withheld per payroll</Th>
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
              const mismatch = m.r ? Math.abs(Number(m.r.taxes_withheld) - m.payroll) > 0.005 : m.payroll > 0
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
          "Withheld per payroll" sums finalized payslips by the month they were paid (pay date) — refunds from annualization reduce it;
          record each monthly 1601-C payment under 1601-C remittances. Amber = payroll and remittance differ.
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
  const [remits, setRemits] = useState<TaxRemittance[]>([])
  const [byMonth, setByMonth] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<Partial<TaxRemittance> & { period_month: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [{ data, error }, slips] = await Promise.all([
        supabase.from('tax_remittances').select('*').eq('entity_id', entity.id).gte('period_month', `${year}-01-01`).lte('period_month', `${year}-12-01`),
        fetchFinalizedPayslipsForTaxYear(entity.id, year),
      ])
      if (error) throw error
      setRemits((data ?? []) as TaxRemittance[])
      // 1601-C covers tax withheld in the month the pay was released
      const m: Record<string, number> = {}
      for (const s of slips) {
        const k = (s.pay_date ?? '').slice(5, 7)
        m[k] = (m[k] ?? 0) + Number(s.withholding_tax)
      }
      setByMonth(m)
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

  if (loading) return <Spinner />
  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  return (
    <Card title={`Monthly BIR Form 1601-C remittances — ${year}`} icon={<Landmark />}>
      <TableShell>
        <thead className="bg-slate-50">
          <tr>
            <Th>Month</Th>
            <Th className="text-right">Withheld per payroll</Th>
            <Th>Date remitted</Th>
            <Th>Reference</Th>
            <Th className="text-right">Total remitted</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {MONTHS.map((mm) => {
            const month = `${year}-${mm}-01`
            const r = remits.find((x) => x.period_month === month)
            const payroll = Math.round((byMonth[mm] ?? 0) * 100) / 100
            return (
              <tr key={mm} className="hover:bg-slate-50">
                <Td className="font-semibold">{fmtMonth(month)}</Td>
                <Td className="text-right">{money(payroll)}</Td>
                <Td className="text-xs">{r?.date_paid ? fmtDate(r.date_paid) : '—'}</Td>
                <Td className="text-xs">{r ? `${r.bank_or_agency || '—'} · ${r.reference_no || '—'}` : '—'}</Td>
                <Td className="text-right font-semibold">{r ? money(Number(r.total_remitted)) : '—'}</Td>
                <Td>
                  <button
                    onClick={() => setEditing(r ? { ...r } : { period_month: month, taxes_withheld: payroll, adjustment: 0, penalties: 0 })}
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
      <p className="mt-3 text-[11px] text-slate-400">
        1601-C is filed and paid monthly (eFPS/eBIRForms); these records feed Part II of the 1604-C.
      </p>

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
              <Field label="Adjustment">
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
