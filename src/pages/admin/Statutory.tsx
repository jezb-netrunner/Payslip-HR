// Statutory tables, read-only. Tax and contribution tables ship with the
// software: the maintainer verifies each version against the agency's
// published table, the database checks its shape and figures, and it is
// released as an update with its effective date (see README, "Updating the
// statutory tables"). Nobody edits them here, so a typo can't misapply a rate;
// a version finalized payrolls may have used is frozen in the database. The
// pay codes (how each allowance and one-time earning is taxed) ship the same way.

import { useCallback, useEffect, useState } from 'react'
import { Calculator, ExternalLink, Scale, ShieldCheck, Tags } from 'lucide-react'
import { Badge, Card, Field, Input, LoadFailed, PageHeader, PendingBadge, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getPayrollRules, setPayCodeRule, setPayCodeSssInclude, setPayrollRule } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { StatutoryVersion } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fmtDate, money } from '../../lib/format'
import { INCOME_CLASS_LABELS, PAY_CODE_TAX_LABELS } from '../../lib/labels'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { reloadPayCodes, usePayCodes } from '../../lib/usePayCodes'
import { lineIncomeClass } from '../../payroll/payCodes'
import MinimumWagesCard from './MinimumWagesCard'
import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax } from '../../payroll/statutory'
import type {
  BirAnnualData,
  BirWhtData,
  DeMinimisCeiling,
  DeMinimisData,
  PagibigData,
  PayCode,
  PayrollRules,
  PhilHealthData,
  SssTableData,
  TaxBracket,
} from '../../payroll/types'

type Kind = StatutoryVersion['kind']

const kindLabels: Record<Kind, string> = {
  sss: 'SSS Contributions (RA 11199)',
  philhealth: 'PhilHealth Premiums (RA 11223)',
  pagibig: 'Pag-IBIG Savings (RA 9679)',
  bir_wht: 'BIR Withholding Tax on Compensation',
  bir_annual: 'BIR Annual Income Tax Table',
  de_minimis: 'De Minimis Benefit Ceilings',
}

const KINDS: Kind[] = ['sss', 'philhealth', 'pagibig', 'bir_wht', 'bir_annual', 'de_minimis']

/** Payroll needs every kind but the de minimis ceilings (none are on file before 2026-01-07). */
const OPTIONAL_KINDS: Kind[] = ['de_minimis']

/** The single figures of a table, for showing what a version changed. */
const FIGURES: Partial<Record<Kind, { key: string; label: string; percent?: boolean }[]>> = {
  sss: [
    { key: 'rate_ee', label: 'Employee share', percent: true },
    { key: 'rate_er', label: 'Employer share', percent: true },
    { key: 'msc_min', label: 'Minimum MSC' },
    { key: 'msc_max', label: 'Maximum MSC' },
    { key: 'msc_step', label: 'MSC step' },
    { key: 'mpf_threshold', label: 'MPF above MSC' },
    { key: 'ec_er_low', label: 'EC below threshold' },
    { key: 'ec_er_high', label: 'EC at/above threshold' },
    { key: 'ec_threshold_msc', label: 'EC threshold MSC' },
  ],
  philhealth: [
    { key: 'rate', label: 'Premium rate', percent: true },
    { key: 'floor', label: 'Salary floor' },
    { key: 'ceiling', label: 'Salary ceiling' },
  ],
  pagibig: [
    { key: 'ee_rate_low', label: 'Employee rate, low earners', percent: true },
    { key: 'low_threshold', label: 'Low-earner threshold' },
    { key: 'ee_rate_high', label: 'Employee rate, others', percent: true },
    { key: 'er_rate', label: 'Employer rate', percent: true },
    { key: 'max_fund_salary', label: 'Maximum fund salary' },
  ],
  bir_annual: [{ key: 'other_benefits_exemption_cap', label: '13th month + other benefits exemption cap' }],
}

const pct = (v: number) => `${+(v * 100).toFixed(4)}%`
const figure = (v: unknown, percent?: boolean) => (typeof v === 'number' ? (percent ? pct(v) : `₱${v.toLocaleString()}`) : '—')

/** What a version changed from the one before it. */
function changesFrom(prev: Pick<StatutoryVersion, 'kind' | 'data'>, v: Pick<StatutoryVersion, 'kind' | 'data'>): string[] {
  const a = prev.data as Record<string, unknown>
  const b = v.data as Record<string, unknown>
  const out = (FIGURES[v.kind] ?? [])
    .filter((f) => a[f.key] !== b[f.key])
    .map((f) => `${f.label} ${figure(a[f.key], f.percent)} → ${figure(b[f.key], f.percent)}`)
  if (v.kind === 'de_minimis' && JSON.stringify(a.items) !== JSON.stringify(b.items)) out.push('new ceilings')
  const brackets = v.kind === 'bir_wht' ? ['daily', 'weekly', 'semi_monthly', 'monthly'] : v.kind === 'bir_annual' ? ['brackets'] : []
  const changedTables = brackets.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  if (changedTables.length) out.push(`new ${changedTables.map((k) => k.replace('_', '-')).join(', ')} brackets`)
  return out
}

export default function Statutory() {
  const [versions, setVersions] = useState<StatutoryVersion[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [sample, setSample] = useState('25000')
  const payCodes = usePayCodes()
  const { isCompanyAdmin } = useAuth()
  const toast = useToast()
  const [savingCode, setSavingCode] = useState('')
  const [rules, setRules] = useState<PayrollRules | null>(null)
  const differential = payCodes.find((c) => c.code === 'MAT_DIFFERENTIAL')

  /** One PENDING setting: save, reload what it changed, and say drafts need recomputing. */
  async function saveRule(key: string, what: string, save: () => Promise<void>) {
    setSavingCode(key)
    try {
      await save()
      await reloadPayCodes()
      setRules(await getPayrollRules())
      toast('success', `${what} saved. Recompute draft payrolls.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Could not save the setting'))
    } finally {
      setSavingCode('')
    }
  }

  async function toggleSss(c: PayCode) {
    setSavingCode(c.code)
    try {
      await setPayCodeSssInclude(c.code, !c.sss_include)
      await reloadPayCodes()
      toast('success', `${c.label}: ${c.sss_include ? 'out of' : 'in'} the SSS base from now on. Recompute draft payrolls.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Could not save the setting'))
    } finally {
      setSavingCode('')
    }
  }

  const load = useCallback(async () => {
    setLoadError('')
    const { data, error } = await supabase
      .from('statutory_versions')
      .select('*')
      .order('kind')
      .order('effective_from', { ascending: false })
    if (error) setLoadError(errorMessage(error, 'Could not load the statutory tables'))
    else setVersions((data ?? []) as StatutoryVersion[])
    try {
      setRules(await getPayrollRules())
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the payroll rules'))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const today = todayManila()
  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!versions) return <Spinner />

  const current = (kind: Kind) => versions.find((v) => v.kind === kind && v.effective_from <= today)
  const sss = current('sss')?.data as SssTableData | undefined
  const ph = current('philhealth')?.data as PhilHealthData | undefined
  const pi = current('pagibig')?.data as PagibigData | undefined
  const wht = current('bir_wht')?.data as BirWhtData | undefined
  const salary = Number(sample) || 0
  // the oldest check among the tables in force
  const lastVerified = KINDS.filter((k) => current(k)).map((k) => current(k)?.verified_on ?? '').sort()[0] || null
  const reviewDue = !lastVerified || lastVerified < `${today.slice(0, 4)}-01-01`

  return (
    <div>
      <PageHeader
        title="Statutory Tables"
        subtitle="Maintained with the software and read-only here. Contribution tables apply by the period worked, tax tables by the pay date — each from its effective date on."
      />

      <div className="space-y-6">
        <Card title="How these tables are kept current" icon={<ShieldCheck />}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
            <li>
              Each version is checked against the agency's published table (BIR revenue regulations, SSS, PhilHealth and
              Pag-IBIG circulars) and released as a software update with its effective date and legal basis.
            </li>
            <li>
              The database refuses a version with a malformed table or an out-of-range figure (for example a tax bracket
              that doesn't follow from the one before it), and keeps every past version: earlier periods keep computing
              with the figures in force then.
            </li>
            <li>
              A version that finalized payrolls may have used is frozen. A change in the law arrives as a new version from
              its effective date, and the draft payrolls it affects are marked for recomputing.
            </li>
            <li>
              Rates usually change on January 1, or when an agency issues a new circular. If you learn of a change, tell
              the system maintainer — the tables aren't typed in here, so a wrong figure can't slip in.
            </li>
          </ul>
          <p className={`mt-3 text-xs font-semibold ${reviewDue ? 'text-amber-700' : 'text-slate-500'}`}>
            {lastVerified ? `The tables in force were last verified on ${fmtDate(lastVerified)}.` : 'The tables in force have no verification date.'}
            {reviewDue && ' This year’s check is due.'}
          </p>
        </Card>

        <Card title="Rules pending legal confirmation" icon={<Scale />}>
          <p className="mb-3 text-sm text-slate-600">
            Where the law isn't confirmed yet, payroll uses the default until {isCompanyAdmin ? 'you change' : 'a company admin changes'} it,
            for every client. Each change is audit-logged and marks draft payrolls for recomputing.
          </p>
          <div className="divide-y divide-slate-100 text-sm">
            {differential && (
              <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
                <div>
                  <p className="font-semibold text-slate-700">Maternity salary differential: income tax</p>
                  <p className="text-xs text-slate-500">RMC 105-2019 (BIR copy not yet confirmed). Default: taxable.</p>
                  <div className="mt-1"><PendingBadge /></div>
                </div>
                <Select
                  value={differential.tax_treatment === 'exempt' ? 'exempt' : 'taxable'}
                  disabled={!isCompanyAdmin || savingCode !== ''}
                  onChange={(e) =>
                    saveRule('P1', 'The differential tax setting', () => setPayCodeRule('MAT_DIFFERENTIAL', 'taxable', e.target.value === 'taxable'))
                  }
                >
                  <option value="taxable">Taxable, as supplementary compensation</option>
                  <option value="exempt">Tax-exempt</option>
                </Select>
              </div>
            )}
            {differential && (
              <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
                <div>
                  <p className="font-semibold text-slate-700">Maternity salary differential: in the 13th month base</p>
                  <p className="text-xs text-slate-500">DOLE DA 01-19 (not yet confirmed). Default: included.</p>
                  <div className="mt-1"><PendingBadge /></div>
                </div>
                <Select
                  value={differential.include_in_13th_month_base ? 'yes' : 'no'}
                  disabled={!isCompanyAdmin || savingCode !== ''}
                  onChange={(e) =>
                    saveRule('P9', 'The 13th month setting', () => setPayCodeRule('MAT_DIFFERENTIAL', 'include_in_13th_month_base', e.target.value === 'yes'))
                  }
                >
                  <option value="yes">Counts toward the 13th month</option>
                  <option value="no">Doesn't count</option>
                </Select>
              </div>
            )}
            {rules && (
              <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
                <div>
                  <p className="font-semibold text-slate-700">PhilHealth and Pag-IBIG during maternity leave</p>
                  <p className="text-xs text-slate-500">
                    The PhilHealth and Pag-IBIG rules for members on leave are not yet read. Default: deduct and remit as usual
                    (keep it unless they say otherwise).
                  </p>
                  <div className="mt-1"><PendingBadge /></div>
                </div>
                <Select
                  value={rules.maternityContributions}
                  disabled={!isCompanyAdmin || savingCode !== ''}
                  onChange={(e) => saveRule('P4', 'The maternity contributions setting', () => setPayrollRule('maternity_contributions', e.target.value))}
                >
                  <option value="as_usual">As usual</option>
                  <option value="pause_full_leave">None on a payroll that is all maternity leave</option>
                </Select>
              </div>
            )}
            {rules && (
              <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start">
                <div>
                  <p className="font-semibold text-slate-700">Pag-IBIG: monthly compensation and ceiling</p>
                  <p className="text-xs text-slate-500">
                    RA 9679 Sec. 4(b) and 7 (HDMF Circular 460 not yet read). Default: basic pay plus the regular allowances,
                    up to the statutory table's maximum fund salary{pi ? ` (₱${pi.max_fund_salary.toLocaleString()})` : ''}. Only the
                    compulsory employee share is excluded from taxable pay.
                  </p>
                  <div className="mt-1"><PendingBadge /></div>
                </div>
                <div className="space-y-2">
                  {(
                    [
                      ['basic', 'pagibig_base_basic', 'Basic pay'],
                      ['cola', 'pagibig_base_cola', 'Mandated COLA'],
                      ['otherAllowances', 'pagibig_base_other_allowances', 'Other regular allowances'],
                    ] as const
                  ).map(([k, rule, label]) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand-700"
                        checked={rules.pagibigBase[k]}
                        disabled={!isCompanyAdmin || savingCode !== ''}
                        onChange={(e) => saveRule('P5', 'The Pag-IBIG setting', () => setPayrollRule(rule, String(e.target.checked)))}
                      />
                      {label}
                    </label>
                  ))}
                  <Field label="Ceiling (PHP a month)" hint="Blank = the statutory table's">
                    <Input
                      key={String(rules.pagibigCeiling)}
                      type="number"
                      min={1}
                      step="0.01"
                      defaultValue={rules.pagibigCeiling ?? ''}
                      placeholder={pi ? String(pi.max_fund_salary) : ''}
                      disabled={!isCompanyAdmin || savingCode !== ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v !== String(rules.pagibigCeiling ?? '')) saveRule('P5', 'The Pag-IBIG ceiling', () => setPayrollRule('pagibig_ceiling', v))
                      }}
                    />
                  </Field>
                </div>
              </div>
            )}
            <p className="py-3 text-xs text-slate-500">
              SSS on 13th month pay, de minimis benefits, other non-taxable pay and the advanced SSS maternity benefit:
              the SSS column of <b>Pay codes</b> below.
            </p>
          </div>
        </Card>

        <MinimumWagesCard isCompanyAdmin={isCompanyAdmin} />

        <Card title="Quick check — contributions for a sample salary" icon={<Calculator />}>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Monthly basic salary (PHP)">
              <Input type="number" value={sample} onChange={(e) => setSample(e.target.value)} className="w-44" />
            </Field>
            {sss && ph && pi && wht && salary > 0 && (() => {
              const s = computeSss(salary, sss)
              const p = computePhilHealth(salary, ph)
              const g = computePagibig(salary, rules?.pagibigCeiling ? { ...pi, max_fund_salary: rules.pagibigCeiling } : pi)
              const monthlyEe = s.ee + s.mpfEe + p.ee + g.ee
              const tax = computeWithholdingTax(salary - monthlyEe, 'monthly', wht)
              return (
                <div className="grid w-full flex-1 grid-cols-2 gap-3 text-sm sm:w-auto sm:min-w-[28rem] sm:grid-cols-5">
                  <div><p className="text-xs text-slate-400">SSS EE (MSC {s.msc.toLocaleString()})</p><p className="font-bold">{money(s.ee + s.mpfEe)}</p></div>
                  <div><p className="text-xs text-slate-400">PhilHealth EE</p><p className="font-bold">{money(p.ee)}</p></div>
                  <div><p className="text-xs text-slate-400">Pag-IBIG EE</p><p className="font-bold">{money(g.ee)}</p></div>
                  <div><p className="text-xs text-slate-400">Monthly W/Tax</p><p className="font-bold">{money(tax)}</p></div>
                  <div><p className="text-xs text-slate-400">Net (est.)</p><p className="font-bold text-brand-800">{money(salary - monthlyEe - tax)}</p></div>
                </div>
              )
            })()}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            A month of basic pay only. Payroll takes SSS on the month's actual pay (overtime and allowances included,
            settled on the month's last payroll) and Pag-IBIG on what the setting above includes (basic pay plus allowances by default).
          </p>
        </Card>

        {KINDS.map((kind) => {
          const rows = versions.filter((v) => v.kind === kind)
          const cur = current(kind)
          return (
            <Card
              key={kind}
              title={
                <span>
                  {kindLabels[kind]} {cur && <Badge tone="green">in force since {fmtDate(cur.effective_from)}</Badge>}
                </span>
              }
            >
              {cur ? (
                <VersionDetail version={cur} />
              ) : OPTIONAL_KINDS.includes(kind) ? (
                <p className="text-sm text-slate-500">No version in force today.</p>
              ) : (
                <p className="text-sm text-rose-600">No version in force — payroll cannot run.</p>
              )}
              {rows.length > 0 && (
                <div className="mt-3 border-t border-slate-100 pt-2">
                  <p className="text-xs font-semibold text-slate-400">All versions</p>
                  {rows.map((v, i) => {
                    const prev = rows[i + 1]
                    const changes = prev ? changesFrom(prev, v) : []
                    return (
                      <div key={v.id} className="py-1.5 text-xs text-slate-500">
                        <p className="flex flex-wrap items-center gap-x-1.5">
                          <span className="font-semibold text-slate-600">Effective {fmtDate(v.effective_from)}</span>
                          {v.effective_from > today && <Badge tone="blue">upcoming</Badge>}
                          {v.legal_basis && <span>· {v.legal_basis}</span>}
                          {v.verified_on && <span>· verified {fmtDate(v.verified_on)}</span>}
                          {v.source_url && (
                            <a href={v.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-600 hover:underline">
                              source <ExternalLink className="size-3" />
                            </a>
                          )}
                        </p>
                        {changes.length > 0 && <p className="mt-0.5 text-slate-400">Changed: {changes.join('; ')}</p>}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          )
        })}

        <Card title="Pay codes" icon={<Tags />}>
          <p className="mb-3 text-sm text-slate-600">
            Every allowance and one-time earning carries a pay code. The code decides how the line is taxed, and whether
            its taxable part is regular compensation (R: basic pay and allowances paid every period) or supplementary
            compensation (S: overtime, premiums, commission, the part of bonuses above the ₱90,000 and other one-time
            pay). Withholding tax takes the table row from R alone. The cumulative average method applies instead, for the
            rest of the year, once S is paid while R is in the 0% row, S is at least R, or the employee had a previous
            employer this year (RR 2-98 Sec. 2.79(B), as amended by RR 11-2018). The SSS column says whether the pay is
            in the month's SSS compensation (RA 11199 Sec. 8(f)): bonuses are, except the Christmas bonus, and liquidated
            transportation, board or lodging is not. Where the law isn't settled, company admins choose; until then it
            stays out.
          </p>
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Pay code</Th>
                <Th>Used for</Th>
                <Th>Tax</Th>
                <Th>Taxable part</Th>
                <Th>SSS</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payCodes.map((c) => (
                <tr key={c.code}>
                  <Td>
                    <p className="font-semibold text-slate-700">{c.label}</p>
                    <p className="text-xs text-slate-400">
                      {c.code}
                      {c.de_minimis_item && ` · de minimis item (${c.de_minimis_item})`}
                      {c.fringe_benefit && ' · fringe benefit for managerial or supervisory staff (FBT, not withheld)'}
                      {!c.active && ' · retired'}
                    </p>
                  </Td>
                  <Td>{[c.for_allowances && 'Allowances', c.for_one_time && 'One-time earnings'].filter(Boolean).join(', ')}</Td>
                  <Td>{PAY_CODE_TAX_LABELS[c.tax_treatment]}</Td>
                  <Td>{taxablePart(c)}</Td>
                  <Td>
                    {c.sss_include_pending && isCompanyAdmin ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={c.sss_include}
                          disabled={savingCode !== ''}
                          onChange={() => toggleSss(c)}
                          aria-label={`${c.label} in the SSS base`}
                        />
                        <span>{c.sss_include ? 'In the base' : 'Out'}</span>
                      </label>
                    ) : (
                      <span>{c.sss_include ? 'In the base' : 'Out'}</span>
                    )}
                    {c.sss_include_pending && <div className="mt-1"><PendingBadge /></div>}
                    {c.is_christmas_bonus && <p className="mt-0.5 text-xs text-slate-400">Christmas bonus</p>}
                    {c.subject_to_liquidation && <p className="mt-0.5 text-xs text-slate-400">Liquidated: not compensation</p>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      </div>
    </div>
  )
}

/** R or S of a pay code's taxable part, by how it is paid. */
function taxablePart(c: PayCode): string {
  if (c.tax_treatment === 'exempt') return '—'
  const every = INCOME_CLASS_LABELS[lineIncomeClass(c, 'allowance')]
  const once = INCOME_CLASS_LABELS[lineIncomeClass(c, 'one_time')]
  if (!c.for_one_time) return every
  if (!c.for_allowances || every === once) return once
  return `${every} every period, ${once} once`
}

function VersionDetail({ version }: { version: StatutoryVersion }) {
  const d = version.data
  const head = (
    <p className="text-sm text-slate-600">
      {version.description}
      {version.legal_basis && <span className="mt-0.5 block text-xs text-slate-400">Legal basis: {version.legal_basis}</span>}
    </p>
  )
  if (version.kind === 'sss') {
    const t = d as SssTableData
    return (
      <div className="text-sm text-slate-600">
        {head}
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <p>Rate: <b>{+((t.rate_ee + t.rate_er) * 100).toFixed(4)}%</b> (EE {pct(t.rate_ee)} / ER {pct(t.rate_er)})</p>
          <p>MSC: <b>₱{t.msc_min.toLocaleString()}–₱{t.msc_max.toLocaleString()}</b> (step ₱{t.msc_step})</p>
          <p>MPF above MSC: <b>₱{t.mpf_threshold.toLocaleString()}</b></p>
          <p>EC: <b>₱{t.ec_er_low}</b> / <b>₱{t.ec_er_high}</b> (MSC ≥ ₱{t.ec_threshold_msc.toLocaleString()})</p>
        </div>
      </div>
    )
  }
  if (version.kind === 'philhealth') {
    const t = d as PhilHealthData
    return (
      <div className="text-sm text-slate-600">
        {head}
        <p className="mt-2 text-xs">
          Rate <b>{pct(t.rate)}</b> of basic salary · floor <b>₱{t.floor.toLocaleString()}</b> · ceiling{' '}
          <b>₱{t.ceiling.toLocaleString()}</b> · split 50/50 (odd centavo to the employer)
        </p>
      </div>
    )
  }
  if (version.kind === 'pagibig') {
    const t = d as PagibigData
    return (
      <div className="text-sm text-slate-600">
        {head}
        <p className="mt-2 text-xs">
          EE <b>{pct(t.ee_rate_low)}</b> (≤ ₱{t.low_threshold.toLocaleString()}) or <b>{pct(t.ee_rate_high)}</b> · ER{' '}
          <b>{pct(t.er_rate)}</b> · max fund salary <b>₱{t.max_fund_salary.toLocaleString()}</b>
        </p>
      </div>
    )
  }
  if (version.kind === 'bir_wht') {
    const t = d as BirWhtData
    return (
      <div>
        <div className="mb-2">{head}</div>
        <div className="grid gap-4 lg:grid-cols-3">
          <BracketTable title="Weekly" brackets={t.weekly} />
          <BracketTable title="Semi-monthly" brackets={t.semi_monthly} />
          <BracketTable title="Monthly" brackets={t.monthly} />
        </div>
      </div>
    )
  }
  if (version.kind === 'de_minimis') {
    const t = d as DeMinimisData
    return (
      <div>
        <div className="mb-2">{head}</div>
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Item</Th>
              <Th>Benefit</Th>
              <Th className="text-right">Ceiling</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {t.items.map((c) => (
              <tr key={c.item}>
                <Td>({c.item})</Td>
                <Td>{c.label}</Td>
                <Td className="text-right">{ceilingText(c)}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
        <p className="mt-2 text-xs text-slate-500">
          Item (b) applies to government employees only. Amounts above a ceiling count toward the ₱90,000 exemption for
          13th month pay and other benefits.
        </p>
      </div>
    )
  }
  const t = d as BirAnnualData
  return (
    <div>
      <div className="mb-2">{head}</div>
      <BracketTable title="Annual" brackets={t.brackets} />
      <p className="mt-2 text-xs text-slate-500">
        13th month pay + other benefits tax-exempt cap: <b>₱{t.other_benefits_exemption_cap.toLocaleString()}</b>
      </p>
    </div>
  )
}

function ceilingText(c: DeMinimisCeiling): string {
  const peso = (v: number) => `₱${v.toLocaleString()}`
  switch (c.unit) {
    case 'days_per_year':
      return `${c.limit} days a year`
    case 'per_month':
      return `${peso(c.limit)} a month`
    case 'per_semester':
      return `${peso(c.limit)} a semester${c.per_month ? ` (${peso(c.per_month)} a month)` : ''}`
    case 'per_year':
      return `${peso(c.limit)} a year`
    case 'share_of_regional_minimum_wage':
      return `${pct(c.limit)} of the regional basic minimum wage`
  }
}

function BracketTable({ title, brackets }: { title: string; brackets: TaxBracket[] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</p>
      <TableShell>
        <thead className="bg-slate-50">
          <tr>
            <Th>Over</Th>
            <Th className="text-right">Base tax</Th>
            <Th className="text-right">Rate on excess</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {brackets.map((b, i) => (
            <tr key={i}>
              <Td>₱{b.over.toLocaleString()}</Td>
              <Td className="text-right">₱{b.base.toLocaleString()}</Td>
              <Td className="text-right">{pct(b.rate)}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
