// Statutory Tables → Minimum wages (spec T12): the statutory minimum wage by
// region and sector, one row per wage order, kept by company admins. Payroll
// compares each employee's basic rate with the rate in force on the
// period's last day. A rate added or changed with a past date lists the
// employees whose status changes; their draft payrolls from that date are
// recomputed, finalized ones stay (the year-end adjustment corrects the year).

import { useState } from 'react'
import { Coins, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Field, IconButton, Input, Modal, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { MinimumWage } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fmtDate, money } from '../../lib/format'
import { PH_REGIONS } from '../../lib/labels'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { reloadMinimumWages, useMinimumWages } from '../../lib/useMinimumWages'
import { usePayrollRules } from '../../lib/usePayrollRules'
import { retroactiveImpact, type SmwClient, type SmwEmployee, type SmwImpact } from '../../payroll/minimumWage'

type Form = { id?: string; region: string; sector: string; daily_rate: string; effective_from: string; effective_to: string; wage_order_ref: string }

const CHANGE_LABELS: Record<SmwImpact['change'], string> = {
  becomes_mwe: 'becomes a minimum wage earner',
  no_longer_mwe: 'is no longer a minimum wage earner',
  below_minimum: 'is now below the minimum wage',
}

export default function MinimumWagesCard({ isCompanyAdmin }: { isCompanyAdmin: boolean }) {
  const toast = useToast()
  const rows = useMinimumWages()
  const rules = usePayrollRules()
  const [region, setRegion] = useState('')
  const [editing, setEditing] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState<{ row: MinimumWage; list: SmwImpact[] } | null>(null)
  const today = todayManila()
  const regionName = (code: string) => PH_REGIONS.find((r) => r.code === code)?.name ?? code

  /** Who the saved rate affects, when it reaches back before today. */
  async function impactOf(before: MinimumWage[], after: MinimumWage[], changed: MinimumWage) {
    const { data: ents, error } = await supabase
      .from('entities')
      .select('id, name, minimum_wage_region, minimum_wage_sector, working_days_divisor')
      .eq('minimum_wage_region', changed.region)
    if (error) throw error
    const ids = (ents ?? []).map((e) => e.id as string)
    const { data: emps, error: empErr } = ids.length
      ? await supabase
          .from('employees')
          .select('id, entity_id, first_name, last_name, pay_type, daily_rate, monthly_rate, days_per_year, separation_date, employment_status')
          .in('entity_id', ids)
      : { data: [], error: null }
    if (empErr) throw empErr
    return retroactiveImpact({
      before,
      after,
      changed,
      entities: (ents ?? []) as SmwClient[],
      employees: (emps ?? []) as SmwEmployee[],
      asOf: today,
      apprenticeMwe: rules?.apprenticeMwe,
    })
  }

  async function save() {
    if (!editing) return
    const rate = Number(editing.daily_rate)
    if (!editing.region || !(rate > 0) || !editing.effective_from || !editing.wage_order_ref.trim()) {
      return toast('error', 'Enter the region, the daily rate, the date it takes effect and the wage order.')
    }
    if (editing.effective_to && editing.effective_to < editing.effective_from) return toast('error', 'The end date comes after the start date.')
    setBusy(true)
    try {
      const before = rows ?? []
      const payload = {
        region: editing.region,
        sector: editing.sector.trim(),
        daily_rate: rate,
        effective_from: editing.effective_from,
        effective_to: editing.effective_to || null,
        wage_order_ref: editing.wage_order_ref.trim(),
      }
      const { data, error } = editing.id
        ? await supabase.from('minimum_wages').update(payload).eq('id', editing.id).select().single()
        : await supabase.from('minimum_wages').insert(payload).select().single()
      if (error) throw error
      const saved = { ...(data as MinimumWage), daily_rate: Number((data as MinimumWage).daily_rate) }
      const after = await reloadMinimumWages()
      setEditing(null)
      toast('success', 'Minimum wage saved (audit-logged). Draft payrolls it covers are marked for recomputing.')
      if (saved.effective_from < today) {
        const was = editing.id ? before.find((r) => r.id === editing.id) : undefined
        const from = was && was.effective_from < saved.effective_from ? { ...saved, effective_from: was.effective_from } : saved
        setImpact({ row: saved, list: await impactOf(before, after, from) })
      }
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(r: MinimumWage) {
    if (!confirm(`Remove the ${regionName(r.region)} rate from ${fmtDate(r.effective_from)} (${r.wage_order_ref})? Use this only for a rate entered by mistake.`)) return
    setBusy(true)
    const { error } = await supabase.from('minimum_wages').delete().eq('id', r.id)
    setBusy(false)
    if (error) return toast('error', errorMessage(error, 'Failed'))
    await reloadMinimumWages()
    toast('success', 'Removed. Draft payrolls it covered are marked for recomputing.')
  }

  const shown = (rows ?? []).filter((r) => !region || r.region === region)
  return (
    <Card
      title="Minimum wages"
      icon={<Coins />}
      actions={
        isCompanyAdmin && (
          <Button
            variant="secondary"
            onClick={() => setEditing({ region: region || 'NCR', sector: '', daily_rate: '', effective_from: today, effective_to: '', wage_order_ref: '' })}
          >
            <Plus className="size-4" /> Add a wage order
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        The statutory minimum wage fixed by each Regional Tripartite Wage and Productivity Board. Payroll compares an
        employee's basic daily rate with the rate in force on the period's last day: at or below it, the employee is a
        minimum wage earner for that payroll; below it, the payslip also warns. A client uses its region's general rate
        unless a rate for its sector is on file; with none on file it uses its own setting.
      </p>
      <div className="mb-3 max-w-xs">
        <Select aria-label="Region" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">All regions</option>
          {PH_REGIONS.map((r) => (
            <option key={r.code} value={r.code}>{r.name}</option>
          ))}
        </Select>
      </div>
      {!rows ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400">No rates on file{region ? ' for this region' : ''} yet.</p>
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Region</Th>
              <Th>Sector</Th>
              <Th className="text-right">Daily rate</Th>
              <Th>In force</Th>
              <Th>Wage order</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr key={r.id}>
                <Td className="font-semibold">{r.region}</Td>
                <Td className="text-xs">{r.sector || 'General'}</Td>
                <Td className="text-right font-semibold">{money(r.daily_rate)}</Td>
                <Td className="whitespace-nowrap text-xs">
                  {fmtDate(r.effective_from)} – {r.effective_to ? fmtDate(r.effective_to) : 'until replaced'}
                </Td>
                <Td className="text-xs">{r.wage_order_ref}</Td>
                <Td>
                  {isCompanyAdmin && (
                    <span className="flex gap-1">
                      <IconButton
                        size="sm"
                        label={`Edit the ${r.region} rate from ${fmtDate(r.effective_from)}`}
                        onClick={() =>
                          setEditing({
                            id: r.id, region: r.region, sector: r.sector, daily_rate: String(r.daily_rate), effective_from: r.effective_from,
                            effective_to: r.effective_to ?? '', wage_order_ref: r.wage_order_ref,
                          })
                        }
                      >
                        <Pencil className="size-3.5" />
                      </IconButton>
                      <IconButton size="sm" label={`Remove the ${r.region} rate from ${fmtDate(r.effective_from)}`} onClick={() => remove(r)}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}

      {impact && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">
            {impact.row.region} {money(impact.row.daily_rate)} from {fmtDate(impact.row.effective_from)}:{' '}
            {impact.list.length === 0 ? 'no employee changes status.' : `${impact.list.length} employee${impact.list.length === 1 ? '' : 's'} affected.`}
          </p>
          {impact.list.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {impact.list.map((i) => (
                <li key={i.employeeId}>
                  • {i.client}: {i.name} ({money(i.daily)} a day) {CHANGE_LABELS[i.change]}
                  {i.below && i.change !== 'below_minimum' ? ' and is below the minimum wage' : ''}
                  {i.before !== null ? ` (was ${money(i.before)})` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs">
            Draft payrolls from that date were marked for recomputing. Finalized payrolls are not changed: the year-end
            adjustment re-tests them and corrects the year's tax. Pay an employee below the new rate the difference for days
            already paid with the "Wage order top-up" pay code, and update their rate.
          </p>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setImpact(null)}>Dismiss</Button>
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit minimum wage' : 'Add a wage order'}>
        {editing && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Region">
                <Select value={editing.region} onChange={(e) => setEditing({ ...editing, region: e.target.value })}>
                  {PH_REGIONS.map((r) => (
                    <option key={r.code} value={r.code}>{r.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Sector" hint="Blank = the region's general rate">
                <Input value={editing.sector} maxLength={100} onChange={(e) => setEditing({ ...editing, sector: e.target.value })} />
              </Field>
              <Field label="Daily rate (PHP)">
                <Input type="number" min={0} step="0.01" value={editing.daily_rate} onChange={(e) => setEditing({ ...editing, daily_rate: e.target.value })} />
              </Field>
              <Field label="Wage order">
                <Input value={editing.wage_order_ref} maxLength={200} placeholder="e.g. NCR-26" onChange={(e) => setEditing({ ...editing, wage_order_ref: e.target.value })} />
              </Field>
              <Field label="In force from">
                <Input type="date" value={editing.effective_from} onChange={(e) => setEditing({ ...editing, effective_from: e.target.value })} />
              </Field>
              <Field label="Until" hint="Blank = until a later rate replaces it">
                <Input type="date" value={editing.effective_to} onChange={(e) => setEditing({ ...editing, effective_to: e.target.value })} />
              </Field>
            </div>
            {editing.effective_from && editing.effective_from < today && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Badge tone="amber">past date</Badge> Draft payrolls from {fmtDate(editing.effective_from)} will be marked for
                recomputing; finalized ones stay as they are (the year-end adjustment corrects the year).
              </p>
            )}
            <Button className="w-full" onClick={save} disabled={busy}>Save</Button>
          </div>
        )}
      </Modal>
    </Card>
  )
}
