// Work schedules from the database — each employee's weekly patterns
// (effective-dated) and roster changes for single dates — turned into a
// resolver per employee (src/payroll/schedule.ts). Shift templates are
// per-client presets; what an employee is scheduled is always the snapshot
// stored on the pattern or roster entry. How schedules read: shiftText.ts.

import { makeResolver, type ScheduleOverride, type ScheduleVersion } from '../payroll/schedule'
import type { ScheduleResolver, Shift } from '../payroll/types'
import type { Employee } from './db'
import { fetchAll } from './fetchAll'
import { supabase } from './supabase'

export interface ScheduleVersionRow extends ScheduleVersion {
  id: string
  entity_id: string
  note: string
  created_at: string
}

export interface ScheduleOverrideRow extends ScheduleOverride {
  id: string
  entity_id: string
  note: string
}

export interface ShiftTemplate {
  id: string
  entity_id: string
  name: string
  shift: Shift
  active: boolean
  sort_order: number
}

export interface ScheduleRows {
  versions: ScheduleVersionRow[]
  overrides: ScheduleOverrideRow[]
}

export const NO_SCHEDULE_ROWS: ScheduleRows = { versions: [], overrides: [] }

/**
 * The patterns that can be in force between `from` and `to` (every one that
 * started by `to`) and the roster changes inside the range — for one client,
 * or one employee of it.
 */
export async function fetchScheduleRows(
  scope: { entityId: string; employeeId?: string } | { employeeId: string },
  from: string,
  to: string,
): Promise<ScheduleRows> {
  const [versions, overrides] = await Promise.all([
    fetchAll<ScheduleVersionRow>((f, t) => {
      let q = supabase.from('employee_schedules').select('id, entity_id, employee_id, effective_from, pattern, note, created_at')
      if ('entityId' in scope) q = q.eq('entity_id', scope.entityId)
      if (scope.employeeId) q = q.eq('employee_id', scope.employeeId)
      return q.lte('effective_from', to).order('effective_from').order('id').range(f, t)
    }),
    fetchAll<ScheduleOverrideRow>((f, t) => {
      let q = supabase.from('schedule_overrides').select('id, entity_id, employee_id, work_date, shift, note')
      if ('entityId' in scope) q = q.eq('entity_id', scope.entityId)
      if (scope.employeeId) q = q.eq('employee_id', scope.employeeId)
      return q.gte('work_date', from).lte('work_date', to).order('work_date').order('id').range(f, t)
    }),
  ])
  return { versions, overrides }
}

/** Each employee's schedule per date. */
export function resolversFor(employees: Pick<Employee, 'id' | 'work_schedule'>[], rows: ScheduleRows): Map<string, ScheduleResolver> {
  const versions = new Map<string, ScheduleVersionRow[]>()
  for (const v of rows.versions) versions.set(v.employee_id, [...(versions.get(v.employee_id) ?? []), v])
  const overrides = new Map<string, ScheduleOverrideRow[]>()
  for (const o of rows.overrides) overrides.set(o.employee_id, [...(overrides.get(o.employee_id) ?? []), o])
  return new Map(
    employees.map((e) => [e.id, makeResolver(e.work_schedule, versions.get(e.id) ?? [], overrides.get(e.id) ?? [])]),
  )
}
