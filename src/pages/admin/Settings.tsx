import { useEffect, useState } from 'react'
import { Banknote, Building2, Coins, FileText, Hash, SlidersHorizontal } from 'lucide-react'
import { Button, Card, Field, Input, NoClient, PageHeader, Select, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Entity } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { CONTRIBUTION_TIMING_LABELS, FREQUENCY_LABELS, PH_REGIONS, ROUNDING_LABELS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { splitClientTin } from '../../lib/format'

export default function Settings() {
  const { entity, reload } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <SettingsForm key={entity.id} initial={entity} onSaved={reload} />
}

/** Mirrors the entities CHECK constraints so the admin gets a plain message. */
function settingsRangeProblem(s: Entity): string | null {
  const n = (v: unknown) => Number(v)
  const int = (v: unknown) => Number.isInteger(Number(v))
  if (!(n(s.minimum_wage_daily) >= 0)) return 'Minimum wage cannot be negative.'
  if (!(n(s.working_days_divisor) > 0 && n(s.working_days_divisor) <= 366)) return 'Days-per-year factor must be between 1 and 366.'
  if (!(n(s.standard_hours_per_day) > 0 && n(s.standard_hours_per_day) <= 24)) return 'Standard hours per day must be above 0 and at most 24.'
  if (!int(s.grace_period_minutes) || n(s.grace_period_minutes) < 0 || n(s.grace_period_minutes) > 240)
    return 'Grace period must be a whole number of minutes, 0–240.'
  if (!(n(s.night_diff_rate) >= 0.1 && n(s.night_diff_rate) <= 1))
    return 'Night differential rate must be at least 0.10 (Labor Code Art. 86) and at most 1.'
  if (!int(s.pay_date_lag_days) || n(s.pay_date_lag_days) < 0 || n(s.pay_date_lag_days) > 31)
    return 'Days from period end to pay date must be a whole number, 0–31.'
  return null
}

function SettingsForm({ initial, onSaved }: { initial: Entity; onSaved: () => Promise<void> }) {
  const toast = useToast()
  const [s, setS] = useState<Entity>(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => setS(initial), [initial])

  const set = <K extends keyof Entity>(k: K, v: Entity[K]) => setS({ ...s, [k]: v })

  async function save() {
    const tin = splitClientTin(s.tin, s.tin_branch_code)
    const problem = !s.name.trim()
      ? 'Registered name is required.'
      : !tin
        ? 'TIN: 9 digits (000-000-000); branch code: 3–5 digits (e.g. 00000).'
        : settingsRangeProblem(s)
    if (problem || !tin) {
      toast('error', problem ?? 'Check the TIN.')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase
        .from('entities')
        .update({
          name: s.name.trim(),
          trade_name: s.trade_name,
          tin: tin.tin,
          tin_branch_code: tin.branch,
          rdo_code: s.rdo_code,
          registered_address: s.registered_address,
          zip_code: s.zip_code,
          contact_number: s.contact_number,
          contact_email: s.contact_email,
          withholding_agent_category: s.withholding_agent_category,
          is_top_withholding_agent: s.is_top_withholding_agent,
          sss_employer_no: s.sss_employer_no,
          philhealth_employer_no: s.philhealth_employer_no,
          pagibig_employer_no: s.pagibig_employer_no,
          default_pay_frequency: s.default_pay_frequency,
          minimum_wage_region: s.minimum_wage_region,
          minimum_wage_daily: Number(s.minimum_wage_daily),
          minimum_wage_reference: s.minimum_wage_reference,
          standard_hours_per_day: Number(s.standard_hours_per_day),
          working_days_divisor: Number(s.working_days_divisor),
          grace_period_minutes: Number(s.grace_period_minutes),
          night_diff_rate: Number(s.night_diff_rate),
          contribution_deduction_timing: s.contribution_deduction_timing,
          net_pay_rounding: s.net_pay_rounding,
          rounding_scope: s.rounding_scope,
          pay_date_lag_days: Number(s.pay_date_lag_days),
          payslip_footer_note: s.payslip_footer_note,
        })
        .eq('id', s.id)
      if (error) throw error
      toast('success', 'Settings saved (audit-logged).')
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Client Settings"
        subtitle={
          <>
            {s.name} · client code <span className="font-mono font-semibold">{s.code}</span> (prefix of employee login codes)
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Employer identity (BIR withholding agent)" icon={<Building2 />}>
          <div className="space-y-3">
            <Field label="Registered name">
              <Input value={s.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Trade / business name">
              <Input value={s.trade_name} onChange={(e) => set('trade_name', e.target.value)} />
            </Field>
            <Field label="Registered address">
              <Textarea rows={2} value={s.registered_address} onChange={(e) => set('registered_address', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="TIN" className="col-span-2">
                <Input value={s.tin} placeholder="000-000-000" onChange={(e) => set('tin', e.target.value)} />
              </Field>
              <Field label="Branch code">
                <Input value={s.tin_branch_code} onChange={(e) => set('tin_branch_code', e.target.value)} />
              </Field>
              <Field label="RDO code">
                <Input value={s.rdo_code} onChange={(e) => set('rdo_code', e.target.value)} />
              </Field>
              <Field label="ZIP code">
                <Input value={s.zip_code} onChange={(e) => set('zip_code', e.target.value)} />
              </Field>
              <Field label="Contact number" className="col-span-2 sm:col-span-3">
                <Input value={s.contact_number} onChange={(e) => set('contact_number', e.target.value)} />
              </Field>
              <Field label="Email" className="col-span-2 sm:col-span-4">
                <Input value={s.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
              </Field>
              <Field label="Withholding agent" className="col-span-2">
                <Select
                  value={s.withholding_agent_category}
                  onChange={(e) => set('withholding_agent_category', e.target.value as Entity['withholding_agent_category'])}
                >
                  <option value="private">Private</option>
                  <option value="government">Government</option>
                </Select>
              </Field>
            </div>
            <Toggle
              checked={s.is_top_withholding_agent}
              onChange={(v) => set('is_top_withholding_agent', v)}
              label="Classified by the BIR as a top withholding agent"
            />
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Employer numbers" icon={<Hash />}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SSS employer no.">
                <Input value={s.sss_employer_no} onChange={(e) => set('sss_employer_no', e.target.value)} />
              </Field>
              <Field label="PhilHealth employer no.">
                <Input value={s.philhealth_employer_no} onChange={(e) => set('philhealth_employer_no', e.target.value)} />
              </Field>
              <Field label="Pag-IBIG employer no.">
                <Input value={s.pagibig_employer_no} onChange={(e) => set('pagibig_employer_no', e.target.value)} />
              </Field>
            </div>
          </Card>
          <Card title="Minimum wage" icon={<Coins />}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Wage region">
                <Select value={s.minimum_wage_region} onChange={(e) => set('minimum_wage_region', e.target.value)}>
                  <option value="">Select…</option>
                  {PH_REGIONS.map((r) => (
                    <option key={r.code} value={r.code}>{r.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Daily minimum wage (PHP)" hint="Update when a new wage order takes effect">
                <Input
                  type="number"
                  step="0.01"
                  value={s.minimum_wage_daily}
                  onChange={(e) => set('minimum_wage_daily', e.target.value as unknown as number)}
                />
              </Field>
              <Field label="Wage order reference" className="col-span-2">
                <Input value={s.minimum_wage_reference} onChange={(e) => set('minimum_wage_reference', e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>

        <Card title="Payroll policy" icon={<SlidersHorizontal />}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default pay frequency" hint="For new employees; set per employee on their record">
              <Select
                value={s.default_pay_frequency}
                onChange={(e) => set('default_pay_frequency', e.target.value as Entity['default_pay_frequency'])}
              >
                {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Contribution deduction timing" hint="How monthly SSS / PhilHealth / Pag-IBIG are spread">
              <Select
                value={s.contribution_deduction_timing}
                onChange={(e) => set('contribution_deduction_timing', e.target.value as Entity['contribution_deduction_timing'])}
              >
                {Object.entries(CONTRIBUTION_TIMING_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Days-per-year factor" hint="261 (Mon–Fri), 313 (6-day week), 365; overridable per employee">
              <Input type="number" value={s.working_days_divisor} onChange={(e) => set('working_days_divisor', e.target.value as unknown as number)} />
            </Field>
            <Field label="Standard hours per day">
              <Input type="number" value={s.standard_hours_per_day} onChange={(e) => set('standard_hours_per_day', e.target.value as unknown as number)} />
            </Field>
            <Field label="Grace period (minutes)">
              <Input type="number" value={s.grace_period_minutes} onChange={(e) => set('grace_period_minutes', e.target.value as unknown as number)} />
            </Field>
            <Field label="Night differential rate" hint="At least 0.10 (10%) for 10pm–6am">
              <Input type="number" step="0.01" value={s.night_diff_rate} onChange={(e) => set('night_diff_rate', e.target.value as unknown as number)} />
            </Field>
            <Field label="Days from period end to pay date" hint="Used to suggest the pay date of new runs">
              <Input type="number" value={s.pay_date_lag_days} onChange={(e) => set('pay_date_lag_days', e.target.value as unknown as number)} />
            </Field>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Cash payroll — whole-peso net pay" icon={<Banknote />}>
            <div className="space-y-3">
              <Field label="Net pay rounding">
                <Select value={s.net_pay_rounding} onChange={(e) => set('net_pay_rounding', e.target.value as Entity['net_pay_rounding'])}>
                  {Object.entries(ROUNDING_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Apply to">
                <Select value={s.rounding_scope} onChange={(e) => set('rounding_scope', e.target.value as Entity['rounding_scope'])}>
                  <option value="cash_only">Employees paid in cash only</option>
                  <option value="all">Every employee</option>
                </Select>
              </Field>
              <p className="text-xs text-slate-400">
                Statutory contributions and tax keep their exact centavos; only the cash handed over is rounded.
                Rounding down is not offered: keeping an employee's centavos would be an unauthorized wage
                deduction. Carried centavos are always paid out on the final pay.
              </p>
            </div>
          </Card>
          <Card title="Payslip" icon={<FileText />}>
            <Field label="Footer note">
              <Textarea rows={2} value={s.payslip_footer_note} onChange={(e) => set('payslip_footer_note', e.target.value)} />
            </Field>
          </Card>
        </div>
      </div>
      <div className="mt-6">
        <Button disabled={busy} onClick={save} className="w-full lg:w-auto">
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
