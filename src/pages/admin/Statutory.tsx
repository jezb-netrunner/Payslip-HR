import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Plus } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Textarea, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { StatutoryVersion } from '../../lib/db'
import { fmtDate, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { computePagibig, computePhilHealth, computeSss, computeWithholdingTax } from '../../payroll/statutory'
import type { BirWhtData, PagibigData, PhilHealthData, SssTableData, TaxBracket } from '../../payroll/types'
import { todayManila } from '../../lib/manila'

const kindLabels: Record<string, string> = {
  sss: 'SSS Contributions (RA 11199)',
  philhealth: 'PhilHealth Premiums (RA 11223)',
  pagibig: 'Pag-IBIG Savings (RA 9679)',
  bir_wht: 'BIR Withholding Tax on Compensation',
  bir_annual: 'BIR Annual Income Tax Table',
}

export default function Statutory() {
  const toast = useToast()
  const [versions, setVersions] = useState<StatutoryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
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
  const current = (kind: string) =>
    versions.find((v) => v.kind === kind && v.effective_from <= today)

  const sss = current('sss')?.data as SssTableData | undefined
  const ph = current('philhealth')?.data as PhilHealthData | undefined
  const pi = current('pagibig')?.data as PagibigData | undefined
  const wht = current('bir_wht')?.data as BirWhtData | undefined

  const salary = Number(sample) || 0

  return (
    <div>
      <PageHeader
        title="Statutory Tables"
        subtitle="Versioned by effective date — payroll always uses the version in force for the pay period. Add a new version when the law changes; no code changes needed."
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add new version
          </Button>
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

          {(['sss', 'philhealth', 'pagibig', 'bir_wht', 'bir_annual'] as const).map((kind) => {
            const rows = versions.filter((v) => v.kind === kind)
            const cur = current(kind)
            return (
              <Card
                key={kind}
                title={
                  <span>
                    {kindLabels[kind]}{' '}
                    {cur && <Badge tone="green">current: effective {fmtDate(cur.effective_from)}</Badge>}
                  </span>
                }
              >
                {cur && <VersionDetail version={cur} />}
                {rows.length > 1 && (
                  <div className="mt-3 border-t border-slate-100 pt-2">
                    <p className="text-xs font-semibold text-slate-400">Version history</p>
                    {rows.map((v) => (
                      <p key={v.id} className="text-xs text-slate-500">
                        • Effective {fmtDate(v.effective_from)} — {v.description.slice(0, 110)}
                        {v.source_url && (
                          <a href={v.source_url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center text-brand-600">
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </p>
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <AddVersionModal
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={async () => {
          setAdding(false)
          toast('success', 'New statutory version added.')
          await load()
        }}
      />
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
          <p>Rate: <b>{((t.rate_ee + t.rate_er) * 100).toFixed(0)}%</b> (EE {t.rate_ee * 100}% / ER {t.rate_er * 100}%)</p>
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
          Rate <b>{(t.rate * 100).toFixed(1)}%</b> of basic salary · floor <b>₱{t.floor.toLocaleString()}</b> ·
          ceiling <b>₱{t.ceiling.toLocaleString()}</b> · split 50/50 employer–employee
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
          EE <b>{t.ee_rate_low * 100}%</b> (≤ ₱{t.low_threshold.toLocaleString()}) or <b>{t.ee_rate_high * 100}%</b> ·
          ER <b>{t.er_rate * 100}%</b> · max fund salary <b>₱{t.max_fund_salary.toLocaleString()}</b>
        </p>
      </div>
    )
  }
  if (version.kind === 'bir_wht') {
    const t = d as BirWhtData
    return (
      <div>
        <p className="mb-2 text-sm text-slate-600">{version.description}</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <BracketTable title="Semi-monthly" brackets={t.semi_monthly} />
          <BracketTable title="Monthly" brackets={t.monthly} />
        </div>
      </div>
    )
  }
  const t = d as { brackets: TaxBracket[]; other_benefits_exemption_cap: number }
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
              <Td className="text-right">{(b.rate * 100).toFixed(0)}%</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}

function AddVersionModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({ kind: 'sss', effective_from: '', description: '', source_url: '', data: '' })
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      if (!f.effective_from) throw new Error('Effective date is required.')
      let parsed: unknown
      try {
        parsed = JSON.parse(f.data)
      } catch {
        throw new Error('Data must be valid JSON matching the existing structure for this kind.')
      }
      const { error } = await supabase.from('statutory_versions').insert({
        kind: f.kind,
        effective_from: f.effective_from,
        description: f.description,
        source_url: f.source_url || null,
        data: parsed,
      })
      if (error) throw error
      await onSaved()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add statutory table version" wide>
      <div className="space-y-4">
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
          Use this when a new law/circular changes rates (e.g. a future SSS schedule). Copy the JSON
          structure of the current version of the same kind, adjust the figures, and set the
          effective date. Payroll runs automatically pick the right version for their period.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(kindLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Effective from">
            <Input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />
          </Field>
        </div>
        <Field label="Description (law / circular reference)">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Source URL">
          <Input value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} />
        </Field>
        <Field label="Data (JSON)">
          <Textarea rows={8} value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} className="font-mono text-xs" />
        </Field>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add version'}
        </Button>
      </div>
    </Modal>
  )
}
