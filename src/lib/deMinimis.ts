// De minimis benefits for the screens: their names, and their ceilings as
// published in legal_parameters (RR 29-2025 for payments from 6 Jan 2026).

import type { DeMinimisCeiling, DeMinimisData, DeMinimisKind } from '../payroll/types'
import { supabase } from './supabase'

export const DE_MINIMIS_LABELS: Record<DeMinimisKind, string> = {
  monetized_vl: 'Monetized unused vacation leave',
  medical_dependents: 'Medical cash allowance to dependents',
  rice: 'Rice subsidy',
  uniform: 'Uniform and clothing allowance',
  medical_assistance: 'Actual medical assistance',
  laundry: 'Laundry allowance',
  achievement_award: 'Employee achievement award',
  christmas_gift: 'Christmas and major anniversary gifts',
  meal_ot: 'Overtime or night-shift meal allowance',
  cba_productivity: 'CBA benefits and productivity incentives',
}

/** The benefits a recurring allowance can be (monetized leave is a one-time conversion). */
export const ALLOWANCE_DE_MINIMIS: DeMinimisKind[] = (Object.keys(DE_MINIMIS_LABELS) as DeMinimisKind[]).filter(
  (k) => k !== 'monetized_vl',
)

/** "₱2,500 a month", "12 days a year", "30% of the regional minimum wage a day of overtime". */
export function ceilingText(c: DeMinimisCeiling | undefined): string {
  if (!c) return 'no ceiling in force'
  const peso = `₱${c.limit.toLocaleString('en-US')}`
  switch (c.per) {
    case 'month': return `${peso} a month`
    case 'semester': return `${peso} a semester`
    case 'year': return `${peso} a year`
    case 'days_year': return `${c.limit} days a year`
    case 'ot_day_of_minimum_wage': return `${Math.round(c.limit * 100)}% of the regional minimum wage per day of overtime or night work`
  }
}

/** The de minimis ceilings in force on a date (null: none published). */
export async function fetchDeMinimis(asOf: string): Promise<DeMinimisData | null> {
  const { data, error } = await supabase
    .from('legal_parameters')
    .select('data')
    .eq('key', 'de_minimis')
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data?.[0]?.data as DeMinimisData | undefined) ?? null
}
