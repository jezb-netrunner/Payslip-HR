// The statutory minimum wages on file (spec T12): reference data company
// admins keep, loaded once per session for every region. Screens use it to
// show the rate in force and each employee's computed MWE status; payroll
// loads its client's region itself.

import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Employee, Entity, MinimumWage } from './db'
import { fmtDate } from './format'
import { todayManila } from './manila'
import { dailyRateOf, minimumWageOn, mweStatusOf, type MinimumWageRow } from '../payroll/minimumWage'
import { round2 } from '../payroll/types'

let loading: Promise<MinimumWage[]> | null = null
const listeners = new Set<(rows: MinimumWage[]) => void>()

async function fetchRows(): Promise<MinimumWage[]> {
  const { data, error } = await supabase.from('minimum_wages').select('*').order('region').order('effective_from', { ascending: false })
  if (error) throw error
  return ((data ?? []) as MinimumWage[]).map((r) => ({ ...r, daily_rate: Number(r.daily_rate) }))
}

function load(): Promise<MinimumWage[]> {
  loading ??= fetchRows().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

/** Load the table again (a rate was added or changed) and update every screen showing it. */
export async function reloadMinimumWages(): Promise<MinimumWage[]> {
  loading = null
  const rows = await load()
  for (const l of listeners) l(rows)
  return rows
}

/** Every rate on file; null while loading (or when it couldn't be read). */
export function useMinimumWages(): MinimumWage[] | null {
  const [rows, setRows] = useState<MinimumWage[] | null>(null)
  useEffect(() => {
    let live = true
    const update = (r: MinimumWage[]) => {
      if (live) setRows(r)
    }
    listeners.add(update)
    load().then(update, () => {})
    return () => {
      live = false
      listeners.delete(update)
    }
  }, [])
  return rows
}

/**
 * The minimum wage a client's payroll uses on a date: the table's rate for
 * its region and sector, else the client's own setting.
 */
export function minimumWageFor(
  entity: Pick<Entity, 'minimum_wage_region' | 'minimum_wage_sector' | 'minimum_wage_daily'>,
  date: string,
  rows: readonly MinimumWageRow[] | null,
): { daily: number | null; source: string } {
  const row = rows ? minimumWageOn(rows, entity.minimum_wage_region ?? '', entity.minimum_wage_sector ?? '', date) : null
  if (row) return { daily: Number(row.daily_rate), source: `${entity.minimum_wage_region}, ${row.wage_order_ref}, from ${fmtDate(row.effective_from)}` }
  const own = Number(entity.minimum_wage_daily) || null
  return { daily: own, source: "the client's own setting (no rate on file for its region)" }
}

/**
 * An employee's MWE status today, at their current rate (payroll decides it
 * for each pay period). An apprentice or learner may be paid 75% of the
 * minimum (Labor Code Arts. 61 and 73): below that, the rate is below the
 * minimum wage.
 */
export function mweToday(
  e: Pick<Employee, 'pay_type' | 'daily_rate' | 'monthly_rate' | 'days_per_year'> & { employment_status?: string },
  entity: Pick<Entity, 'minimum_wage_region' | 'minimum_wage_sector' | 'minimum_wage_daily' | 'working_days_divisor'>,
  rows: readonly MinimumWageRow[] | null,
  date = todayManila(),
): { isMwe: boolean; below: boolean; daily: number; smw: number | null; source: string } {
  const daily = dailyRateOf(e, Number(e.days_per_year ?? entity.working_days_divisor))
  const smw = minimumWageFor(entity, date, rows)
  const floor = smw.daily === null ? null : round2(smw.daily * (e.employment_status === 'apprentice' ? 0.75 : 1))
  return { isMwe: mweStatusOf(daily, smw.daily).isMwe, below: mweStatusOf(daily, floor).below, daily, smw: smw.daily, source: smw.source }
}
