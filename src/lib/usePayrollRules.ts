// The PENDING payroll rules (spec P4, P5, the apprentice rule), loaded once
// per session for the screens that show their effect; payroll loads them
// itself. Statutory Tables reloads them after a change.

import { useEffect, useState } from 'react'
import { getPayrollRules } from './api'
import type { PayrollRules } from '../payroll/types'

let loading: Promise<PayrollRules> | null = null
const listeners = new Set<(rules: PayrollRules) => void>()

function load(): Promise<PayrollRules> {
  loading ??= getPayrollRules().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

/** Load the rules again (a company admin changed one) and update every screen showing them. */
export async function reloadPayrollRules(): Promise<PayrollRules> {
  loading = null
  const rules = await load()
  for (const l of listeners) l(rules)
  return rules
}

/** The rules in force; null while loading (or when they couldn't be read). */
export function usePayrollRules(): PayrollRules | null {
  const [rules, setRules] = useState<PayrollRules | null>(null)
  useEffect(() => {
    let live = true
    const update = (r: PayrollRules) => {
      if (live) setRules(r)
    }
    listeners.add(update)
    load().then(update, () => {})
    return () => {
      live = false
      listeners.delete(update)
    }
  }, [])
  return rules
}
