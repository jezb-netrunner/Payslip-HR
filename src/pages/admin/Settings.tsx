import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Field, Input, PageHeader, Select, Spinner, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getSettings } from '../../lib/api'
import type { CompanySettings } from '../../lib/db'
import { supabase } from '../../lib/supabase'

export default function Settings() {
  const toast = useToast()
  const [s, setS] = useState<CompanySettings | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setS(await getSettings())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!s) return <Spinner />

  const set = (k: keyof CompanySettings, v: unknown) => setS({ ...s, [k]: v } as CompanySettings)

  async function save() {
    if (!s) return
    setBusy(true)
    try {
      const { error } = await supabase
        .from('company_settings')
        .update({
          company_name: s.company_name,
          address: s.address,
          tin: s.tin,
          rdo_code: s.rdo_code,
          sss_employer_no: s.sss_employer_no,
          philhealth_employer_no: s.philhealth_employer_no,
          pagibig_employer_no: s.pagibig_employer_no,
          pay_frequency: s.pay_frequency,
          minimum_wage_daily: Number(s.minimum_wage_daily),
          minimum_wage_region: s.minimum_wage_region,
          standard_hours_per_day: Number(s.standard_hours_per_day),
          working_days_divisor: Number(s.working_days_divisor),
          grace_period_minutes: Number(s.grace_period_minutes),
          night_diff_rate: Number(s.night_diff_rate),
          contribution_deduction_timing: s.contribution_deduction_timing,
          require_selfie_on_punch: s.require_selfie_on_punch,
          require_location_on_punch: s.require_location_on_punch,
          payslip_footer_note: s.payslip_footer_note,
        })
        .eq('id', 1)
      if (error) throw error
      toast('success', 'Settings saved (audit-logged).')
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title="Company Settings" subtitle="Single-entity configuration — changes are audit-logged" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Company identity">
          <div className="space-y-3">
            <Field label="Company name">
              <Input value={s.company_name} onChange={(e) => set('company_name', e.target.value)} />
            </Field>
            <Field label="Registered address">
              <Textarea rows={2} value={s.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="TIN"><Input value={s.tin} onChange={(e) => set('tin', e.target.value)} /></Field>
              <Field label="RDO code"><Input value={s.rdo_code} onChange={(e) => set('rdo_code', e.target.value)} /></Field>
              <Field label="SSS employer no."><Input value={s.sss_employer_no} onChange={(e) => set('sss_employer_no', e.target.value)} /></Field>
              <Field label="PhilHealth employer no."><Input value={s.philhealth_employer_no} onChange={(e) => set('philhealth_employer_no', e.target.value)} /></Field>
              <Field label="Pag-IBIG employer no."><Input value={s.pagibig_employer_no} onChange={(e) => set('pagibig_employer_no', e.target.value)} /></Field>
            </div>
          </div>
        </Card>

        <Card title="Payroll policy">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pay frequency">
              <Select value={s.pay_frequency} onChange={(e) => set('pay_frequency', e.target.value)}>
                <option value="semi_monthly">Semi-monthly (twice a month)</option>
                <option value="monthly">Monthly</option>
              </Select>
            </Field>
            <Field label="Contribution deduction timing" hint="How monthly SSS/PhilHealth/Pag-IBIG are spread across semi-monthly periods">
              <Select
                value={s.contribution_deduction_timing}
                onChange={(e) => set('contribution_deduction_timing', e.target.value)}
              >
                <option value="split">Split 50/50 per half</option>
                <option value="first_half">All on 1st half</option>
                <option value="second_half">All on 2nd half</option>
              </Select>
            </Field>
            <Field label="Minimum wage (daily)" hint="Set by your region's wage board (RTWPB) — update when a new wage order takes effect">
              <Input type="number" step="0.01" value={s.minimum_wage_daily} onChange={(e) => set('minimum_wage_daily', e.target.value)} />
            </Field>
            <Field label="Wage order / region reference">
              <Input value={s.minimum_wage_region} onChange={(e) => set('minimum_wage_region', e.target.value)} />
            </Field>
            <Field label="Standard hours per day">
              <Input type="number" value={s.standard_hours_per_day} onChange={(e) => set('standard_hours_per_day', e.target.value)} />
            </Field>
            <Field label="Working days divisor" hint="DOLE factor for monthly↔daily conversion: 261 (Mon–Fri), 313 (6-day week), 365">
              <Input type="number" value={s.working_days_divisor} onChange={(e) => set('working_days_divisor', e.target.value)} />
            </Field>
            <Field label="Grace period (minutes)">
              <Input type="number" value={s.grace_period_minutes} onChange={(e) => set('grace_period_minutes', e.target.value)} />
            </Field>
            <Field label="Night differential rate" hint="Labor Code minimum: 0.10 (10%) for 10pm–6am">
              <Input type="number" step="0.01" value={s.night_diff_rate} onChange={(e) => set('night_diff_rate', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Punch security (anti-buddy-punching)">
          <div className="space-y-3">
            <Toggle
              checked={s.require_selfie_on_punch}
              onChange={(v) => set('require_selfie_on_punch', v)}
              label="Require a verification selfie on every punch"
            />
            <Toggle
              checked={s.require_location_on_punch}
              onChange={(v) => set('require_location_on_punch', v)}
              label="Require location sharing on every punch"
            />
            <p className="text-xs text-slate-400">
              Always on: server-side timestamps, per-account punching only (an employee can never
              punch for someone else), device fingerprinting, IP capture, immutable entries with
              admin-reviewed corrections, and full audit logging.
            </p>
          </div>
        </Card>

        <Card title="Payslip">
          <Field label="Payslip footer note">
            <Textarea rows={2} value={s.payslip_footer_note} onChange={(e) => set('payslip_footer_note', e.target.value)} />
          </Field>
        </Card>
      </div>
      <div className="mt-6">
        <Button disabled={busy} onClick={save} className="w-full lg:w-auto">
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
