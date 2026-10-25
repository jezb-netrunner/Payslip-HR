// The pay codes on file: reference data that ships with the software (a few
// fields are company-admin settings), loaded once per session. Screens start
// with the shipped list (src/payroll/payCodes.ts mirrors the database) and
// switch to the database's rows once they arrive.

import { useEffect, useState } from 'react'
import { getPayCodes } from './api'
import { PAY_CODE_TAX_LABELS } from './labels'
import { lineIncomeClass, PAY_CODES } from '../payroll/payCodes'
import type { PayCode } from '../payroll/types'

let loading: Promise<PayCode[]> | null = null
const listeners = new Set<(codes: readonly PayCode[]) => void>()

function load(): Promise<PayCode[]> {
  loading ??= getPayCodes().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

/** Load the pay codes again (a setting changed) and update every screen showing them. */
export async function reloadPayCodes(): Promise<void> {
  loading = null
  const rows = await load()
  for (const l of listeners) l(rows)
}

export function usePayCodes(): readonly PayCode[] {
  const [codes, setCodes] = useState<readonly PayCode[]>(PAY_CODES)
  useEffect(() => {
    let live = true
    const update = (rows: readonly PayCode[]) => {
      if (live && rows.length > 0) setCodes(rows)
    }
    listeners.add(update)
    load().then(update, () => {}) // keep the shipped list; saving still goes through the database's checks
    return () => {
      live = false
      listeners.delete(update)
    }
  }, [])
  return codes
}

/** A pay code's label, or the code itself when it isn't on the list. */
export function payCodeLabel(codes: readonly PayCode[], code: string | null | undefined): string {
  if (!code) return ''
  return codes.find((c) => c.code === code)?.label ?? code
}

/** What a pay code is and how its line is taxed, for the form that picks it. */
export function payCodeHint(c: PayCode, usage: 'allowance' | 'one_time'): string {
  const part = lineIncomeClass(c, usage) === 'regular' ? 'regular compensation (R)' : 'supplementary compensation (S)'
  return `${c.description} ${PAY_CODE_TAX_LABELS[c.tax_treatment]}${c.tax_treatment === 'exempt' ? '' : ` · ${part}`}.`
}
