import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { StatutoryVersion } from '../../lib/db'
import { fmtDate, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax } from '../../payroll/statutory'
import type { BirAnnualData, BirWhtData, PagibigData, PhilHealthData, SssTableData, TaxBracket } from '../../payroll/types'
import { errorMessage } from '../../lib/errors'

type Kind = StatutoryVersion['kind']

const kindLabels: Record<Kind, string> = {
  sss: 'SSS Contributions (RA 11199)',
  philhealth: 'PhilHealth Premiums (RA 11223)',
  pagibig: 'Pag-IBIG Savings (RA 9679)',
  bir_wht: 'BIR Withholding Tax on Compensation',
  bir_annual: 'BIR Annual Income Tax Table',
}

const KINDS: Kind[] = ['sss', 'philhealth', 'pagibig', 'bir_wht', 'bir_annual']

export default function Statutory() {
  const toast = useToast()
  const { isCompanyAdmin } = useAuth()
  const [versions, setVersions] = useState<StatutoryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ kind: Kind; version: Partial<StatutoryVersion> } | null>(null)
  const [sample, setSample] = useState('25000')

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('statutory_versions')
      .select('*')
      .order('kind')
      .order('effective_from', { ascending: false })
    setVersions((data ?? []) as StatutoryVersion[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const today = todayManila()
  const current = (kind: Kind) => versions.find((v) => v.kind === kind && v.effective_from <= today)

  const sss = current('sss')?.data as SssTableData | undefined
  const ph = current('philhealth')?.data as PhilHealthData | undefined
  const pi = current('pagibig')?.data as PagibigData | undefined
  const wht = current('bir_wht')?.data as BirWhtData | undefined
  const salary = Number(sample) || 0

  async function remove(v: StatutoryVersion) {
    if (!confirm(`Delete the ${kindLabels[v.kind]} version effective ${fmtDate(v.effective_from)}? Draft payrolls recomputed afterwards use the remaining versions; finalized payslips are unaffected.`)) return
    const { error } = await supabase.from('statutory_versions').delete().eq('id', v.id)
    if (error) toast('error', error.message)
    else {
      toast('success', 'Version deleted (audit-logged).')
      await load()
    }
  }

  return (
    <div>
      <PageHeader
        title="Statutory Tables"
        subtitle={
          isCompanyAdmin
            ? 'Versioned by effective date: payroll uses the version in force at each period end. When a law or circular changes a rate, add a new version — no code changes needed.'
            : 'Maintained by your company admins. Payroll uses the version in force at each period end.'
        }
      />

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <Card title="Quick check — contributions for a sample salary">
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Monthly basic salary (PHP)">
                <Input type="number" value={sample} onChange={(e) => setSample(e.target.value)} className="w-44" />
              </Field>
              {sss && ph && pi && wht && salary > 0 && (() => {
                const s = computeSss(salary, sss)
                const p = computePhilHealth(salary, ph)
                const g = computePagibig(salary, pi)
                const monthlyEe = s.ee + s.mpfEe + p.ee + g.ee
                const tax = computeWithholdingTax(salary - monthlyEe, 'monthly', wht)
                return (
                  <div className="grid flex-1 grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                    <div><p className="text-xs text-slate-400">SSS EE (MSC {s.msc.toLocaleString()})</p><p className="font-bold">{money(s.ee + s.mpfEe)}</p></div>
                    <div><p className="text-xs text-slate-400">PhilHealth EE</p><p className="font-bold">{money(p.ee)}</p></div>
                    <div><p className="text-xs text-slate-400">Pag-IBIG EE</p><p className="font-bold">{money(g.ee)}</p></div>
                    <div><p className="text-xs text-slate-400">Monthly W/Tax</p><p className="font-bold">{money(tax)}</p></div>
                    <div><p className="text-xs text-slate-400">Net (est.)</p><p className="font-bold text-brand-800">{money(salary - monthlyEe - tax)}</p></div>
                  </div>
                )
              })()}
            </div>
          </Card>

          {KINDS.map((kind) => {
            const rows = versions.filter((v) => v.kind === kind)
            const cur = current(kind)
            return (
              <Card
                key={kind}
                title={
                  <span>
                    {kindLabels[kind]}{' '}
                    {cur && <Badge tone="green">in force since {fmtDate(cur.effective_from)}</Badge>}
                  </span>
                }
                actions={
                  isCompanyAdmin && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setEditing({
                          kind,
                          version: {
                            kind,
                            data: structuredClone((rows[0] ?? cur)?.data ?? {}),
                            description: '',
                            source_url: '',
                            effective_from: '',
                          },
                        })
                      }
                    >
                      <Plus className="size-4" /> New version
                    </Button>
                  )
                }
              >
                {cur ? <VersionDetail version={cur} /> : <p className="text-sm text-rose-600">No version in force — payroll cannot run.</p>}
                {rows.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-2">
                    <p className="text-xs font-semibold text-slate-400">All versions</p>
                    {rows.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-3 py-1 text-xs text-slate-500">
                        <span>
                          • Effective {fmtDate(v.effective_from)}
                          {v.effective_from > today && <Badge tone="blue">upcoming</Badge>} — {v.description.slice(0, 110)}
                          {v.source_url && (
                            <a href={v.source_url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center text-brand-600">
                              <ExternalLink className="size-3" />
                            </a>
                          )}
                        </span>
                        {isCompanyAdmin && (
                          <span className="flex shrink-0 gap-2">
                            <button onClick={() => setEditing({ kind, version: structuredClone(v) })} className="text-slate-400 hover:text-brand-700" title="Edit">
                              <Pencil className="size-3.5" />
                            </button>
                            {rows.length > 1 && (
                              <button onClick={() => remove(v)} className="text-slate-300 hover:text-rose-500" title="Delete">
                                <Trash2 className="size-3.5" />
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {editing && (
        <VersionEditor
          kind={editing.kind}
          initial={editing.version}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            toast('success', 'Statutory table saved (audit-logged).')
            await load()
          }}
        />
      )}
    </div>
  )
}

function VersionDetail({ version }: { version: StatutoryVersion }) {
  const d = version.data
  if (version.kind === 'sss') {
    const t = d as SssTableData
    return (
      <div className="text-sm text-slate-600">
        <p>{version.description}</p>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <p>Rate: <b>{+((t.rate_ee + t.rate_er) * 100).toFixed(4)}%</b> (EE {+(t.rate_ee * 100).toFixed(4)}% / ER {+(t.rate_er * 100).toFixed(4)}%)</p>
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
        <p>{version.description}</p>
        <p className="mt-2 text-xs">
          Rate <b>{+(t.rate * 100).toFixed(4)}%</b> of basic salary · floor <b>₱{t.floor.toLocaleString()}</b> ·
          ceiling <b>₱{t.ceiling.toLocaleString()}</b> · split 50/50 (odd centavo to the employer)
        </p>
      </div>
    )
  }
  if (version.kind === 'pagibig') {
    const t = d as PagibigData
    return (
      <div className="text-sm text-slate-600">
        <p>{version.description}</p>
        <p className="mt-2 text-xs">
          EE <b>{+(t.ee_rate_low * 100).toFixed(4)}%</b> (≤ ₱{t.low_threshold.toLocaleString()}) or <b>{+(t.ee_rate_high * 100).toFixed(4)}%</b> ·
          ER <b>{+(t.er_rate * 100).toFixed(4)}%</b> · max fund salary <b>₱{t.max_fund_salary.toLocaleString()}</b>
        </p>
      </div>
    )
  }
  if (version.kind === 'bir_wht') {
    const t = d as BirWhtData
    return (
      <div>
        <p className="mb-2 text-sm text-slate-600">{version.description}</p>
        <div className="grid gap-4 lg:grid-cols-3">
          <BracketTable title="Weekly" brackets={t.weekly} />
          <BracketTable title="Semi-monthly" brackets={t.semi_monthly} />
          <BracketTable title="Monthly" brackets={t.monthly} />
        </div>
      </div>
    )
  }
  const t = d as BirAnnualData
  return (
    <div>
      <p className="mb-2 text-sm text-slate-600">{version.description}</p>
      <BracketTable title="Annual" brackets={t.brackets} />
      <p className="mt-2 text-xs text-slate-500">
        13th month pay + other benefits tax-exempt cap: <b>₱{t.other_benefits_exemption_cap.toLocaleString()}</b>
      </p>
    </div>
  )
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
              <Td className="text-right">{+(b.rate * 100).toFixed(4)}%</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}

// ---------- structured editor (company admins) ----------

type NumField = { key: string; label: string; percent?: boolean }

const SCALAR_FIELDS: Partial<Record<Kind, NumField[]>> = {
  sss: [
    { key: 'rate_ee', label: 'Employee share', percent: true },
    { key: 'rate_er', label: 'Employer share', percent: true },
    { key: 'msc_min', label: 'Minimum MSC (₱)' },
    { key: 'msc_max', label: 'Maximum MSC (₱)' },
    { key: 'msc_step', label: 'MSC step (₱)' },
    { key: 'mpf_threshold', label: 'MPF/WISP above MSC (₱)' },
    { key: 'ec_er_low', label: 'EC (employer) below threshold (₱)' },
    { key: 'ec_er_high', label: 'EC (employer) at/above threshold (₱)' },
    { key: 'ec_threshold_msc', label: 'EC threshold MSC (₱)' },
  ],
  philhealth: [
    { key: 'rate', label: 'Premium rate (total)', percent: true },
    { key: 'floor', label: 'Salary floor (₱)' },
    { key: 'ceiling', label: 'Salary ceiling (₱)' },
  ],
  pagibig: [
    { key: 'ee_rate_low', label: 'Employee rate, low earners', percent: true },
    { key: 'low_threshold', label: 'Low-earner threshold (₱/month)' },
    { key: 'ee_rate_high', label: 'Employee rate, others', percent: true },
    { key: 'er_rate', label: 'Employer rate', percent: true },
    { key: 'max_fund_salary', label: 'Maximum fund salary (₱)' },
  ],
  bir_annual: [{ key: 'other_benefits_exemption_cap', label: '13th month + other benefits exemption cap (₱)' }],
}

const BRACKET_SETS: Partial<Record<Kind, { key: string; label: string }[]>> = {
  bir_wht: [
    { key: 'daily', label: 'Daily' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'semi_monthly', label: 'Semi-monthly' },
    { key: 'monthly', label: 'Monthly' },
  ],
  bir_annual: [{ key: 'brackets', label: 'Annual' }],
}

const pctIn = (v: number) => String(+(v * 100).toFixed(6))
const pctOut = (s: string) => +(Number(s) / 100).toFixed(8)

function validate(kind: Kind, data: Record<string, unknown>): string | null {
  for (const f of SCALAR_FIELDS[kind] ?? []) {
    const v = data[f.key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${f.label} must be a number ≥ 0.`
    if (f.percent && v > 1) return `${f.label} must be at most 100%.`
  }
  for (const set of BRACKET_SETS[kind] ?? []) {
    const rows = data[set.key] as TaxBracket[] | undefined
    if (!rows || rows.length === 0) return `${set.label} table needs at least one bracket.`
    if (rows[0].over !== 0) return `${set.label} table must start at ₱0.`
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if ([r.over, r.base, r.rate].some((x) => !Number.isFinite(x) || x < 0)) return `${set.label} bracket ${i + 1} has an invalid number.`
      if (r.rate > 1) return `${set.label} bracket ${i + 1}: rate must be at most 100%.`
      if (i > 0 && r.over <= rows[i - 1].over) return `${set.label} brackets must be in ascending order.`
    }
  }
  if (kind === 'sss') {
    const d = data as unknown as SssTableData
    if (d.msc_min > d.msc_max || d.msc_step <= 0) return 'Check the MSC range and step.'
  }
  if (kind === 'philhealth') {
    const d = data as unknown as PhilHealthData
    if (d.floor > d.ceiling) return 'The salary floor must not exceed the ceiling.'
  }
  return null
}

function VersionEditor({
  kind,
  initial,
  onClose,
  onSaved,
}: {
  kind: Kind
  initial: Partial<StatutoryVersion>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [meta, setMeta] = useState({
    effective_from: initial.effective_from ?? '',
    description: initial.description ?? '',
    source_url: initial.source_url ?? '',
  })
  const data = (initial.data as Record<string, unknown>) ?? {}
  // percent fields are edited as text so partial input ("0.") survives
  const [scalarText, setScalarText] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const f of SCALAR_FIELDS[kind] ?? []) {
      const v = Number((initial.data as Record<string, number> | undefined)?.[f.key] ?? 0)
      out[f.key] = f.percent ? pctIn(v) : String(v)
    }
    return out
  })
  // bracket rows are edited as text too, parsed on save
  type BracketText = { over: string; base: string; rate: string }
  const [brackets, setBrackets] = useState<Record<string, BracketText[]>>(() => {
    const out: Record<string, BracketText[]> = {}
    for (const set of BRACKET_SETS[kind] ?? []) {
      const rows = ((initial.data as Record<string, TaxBracket[]> | undefined)?.[set.key] ?? []) as TaxBracket[]
      out[set.key] = rows.map((b) => ({ over: String(b.over), base: String(b.base), rate: pctIn(b.rate) }))
    }
    return out
  })
  const [busy, setBusy] = useState(false)

  function setBracket(key: string, i: number, field: keyof BracketText, value: string) {
    setBrackets({ ...brackets, [key]: brackets[key].map((r, j) => (j === i ? { ...r, [field]: value } : r)) })
  }

  async function save() {
    if (!meta.effective_from) return toast('error', 'Effective date is required.')
    if (!meta.description.trim()) return toast('error', 'Describe the law or circular (e.g. "SSS Circular 2027-001").')
    const merged: Record<string, unknown> = { ...data }
    for (const f of SCALAR_FIELDS[kind] ?? []) {
      const raw = scalarText[f.key] ?? ''
      merged[f.key] = raw.trim() === '' ? NaN : f.percent ? pctOut(raw) : Number(raw)
    }
    for (const set of BRACKET_SETS[kind] ?? []) {
      merged[set.key] = (brackets[set.key] ?? []).map((r) => ({
        over: r.over.trim() === '' ? NaN : Number(r.over),
        base: r.base.trim() === '' ? NaN : Number(r.base),
        rate: r.rate.trim() === '' ? NaN : pctOut(r.rate),
      }))
    }
    const problem = validate(kind, merged)
    if (problem) return toast('error', problem)
    setBusy(true)
    try {
      const payload = {
        kind,
        effective_from: meta.effective_from,
        description: meta.description.trim(),
        source_url: meta.source_url.trim() || null,
        data: merged,
      }
      const { error } = initial.id
        ? await supabase.from('statutory_versions').update(payload).eq('id', initial.id)
        : await supabase.from('statutory_versions').insert(payload)
      if (error) throw error
      await onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Failed')
      toast('error', /kind_effective_from_key|unique/.test(msg) ? 'A version with that effective date already exists — edit it instead.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`${initial.id ? 'Edit' : 'New'} version — ${kindLabels[kind]}`} wide>
      <div className="space-y-5">
        {initial.id ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Editing corrects this version in place. Draft payrolls pick it up when recomputed; finalized payslips keep
            the figures they were computed with. For an actual change in the law, add a new version instead.
          </p>
        ) : (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
            Prefilled from the latest version. Change what the new law or circular changes and set the date it takes
            effect — earlier periods keep computing with the old figures.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Effective from">
            <Input type="date" value={meta.effective_from} onChange={(e) => setMeta({ ...meta, effective_from: e.target.value })} />
          </Field>
          <Field label="Legal basis / description" className="sm:col-span-2">
            <Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          </Field>
          <Field label="Source URL" className="sm:col-span-3">
            <Input value={meta.source_url} onChange={(e) => setMeta({ ...meta, source_url: e.target.value })} />
          </Field>
        </div>

        {(SCALAR_FIELDS[kind] ?? []).length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {(SCALAR_FIELDS[kind] ?? []).map((f) => (
              <Field key={f.key} label={f.percent ? `${f.label} (%)` : f.label}>
                <Input
                  inputMode="decimal"
                  value={scalarText[f.key] ?? ''}
                  onChange={(e) => setScalarText({ ...scalarText, [f.key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        )}

        {(BRACKET_SETS[kind] ?? []).map((set) => (
          <div key={set.key}>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{set.label} brackets</p>
              <button
                className="text-xs font-semibold text-brand-600"
                onClick={() => setBrackets({ ...brackets, [set.key]: [...(brackets[set.key] ?? []), { over: '', base: '', rate: '' }] })}
              >
                + Add bracket
              </button>
            </div>
            <TableShell>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Compensation over (₱)</Th>
                  <Th>Base tax (₱)</Th>
                  <Th>Rate on excess (%)</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(brackets[set.key] ?? []).map((b, i) => (
                  <tr key={i}>
                    <Td><Input inputMode="decimal" value={b.over} onChange={(e) => setBracket(set.key, i, 'over', e.target.value)} /></Td>
                    <Td><Input inputMode="decimal" value={b.base} onChange={(e) => setBracket(set.key, i, 'base', e.target.value)} /></Td>
                    <Td><Input inputMode="decimal" value={b.rate} onChange={(e) => setBracket(set.key, i, 'rate', e.target.value)} /></Td>
                    <Td>
                      {i > 0 && (
                        <button
                          onClick={() => setBrackets({ ...brackets, [set.key]: brackets[set.key].filter((_, j) => j !== i) })}
                          className="text-slate-300 hover:text-rose-500"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        ))}

        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : initial.id ? 'Save changes' : 'Add version'}
        </Button>
      </div>
    </Modal>
  )
}
