// One employee's work schedule over a date range, for the screens that
// show or count their days (attendance, leave). See src/lib/schedules.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Employee } from './db'
import { errorMessage } from './errors'
import { fetchScheduleRows, NO_SCHEDULE_ROWS, resolversFor, type ScheduleRows } from './schedules'

/**
 * One employee's schedule for a date range. Until the rows arrive (or if
 * they fail to load) `resolve` follows the base schedule; `ready` says when
 * it is the real one.
 */
export function useEmployeeSchedule(
  employee: Pick<Employee, 'id' | 'entity_id' | 'work_schedule'> | null,
  from: string,
  to: string,
  { asEmployee = false }: { asEmployee?: boolean } = {},
) {
  const [rows, setRows] = useState<{ key: string; rows: ScheduleRows } | null>(null)
  const [error, setError] = useState('')
  // a slow answer for an earlier range must not overwrite a newer one
  const seq = useRef(0)
  const employeeId = employee?.id
  const entityId = employee?.entity_id
  const key = employeeId && from && to && from <= to ? `${employeeId}|${from}|${to}` : ''
  const load = useCallback(async () => {
    if (!employeeId || !entityId || !key) return
    const my = ++seq.current
    setError('')
    try {
      const r = await fetchScheduleRows(asEmployee ? { employeeId } : { entityId, employeeId }, from, to)
      if (my === seq.current) setRows({ key, rows: r })
    } catch (err) {
      if (my === seq.current) setError(errorMessage(err, 'Could not load the schedule'))
    }
  }, [key, asEmployee, employeeId, entityId, from, to])
  useEffect(() => {
    load()
  }, [load])
  const current = rows && rows.key === key ? rows.rows : null
  const resolve = useMemo(
    () => (employee ? resolversFor([employee], current ?? NO_SCHEDULE_ROWS).get(employee.id)! : null),
    [employee, current],
  )
  return { resolve, ready: current !== null, error, reload: load }
}
