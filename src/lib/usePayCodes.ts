// The pay codes on file: reference data that ships with the software, so it
// is loaded once per session. Screens start with the shipped list
// (src/payroll/payCodes.ts mirrors the database) and switch to the
// database's rows once they arrive.

import { useEffect, useState } from 'react'
import { getPayCodes } from './api'
import { PAY_CODE_TAX_LABELS } from './labels'
import { lineIncomeClass, PAY_CODES } from '../payroll/payCodes'
import type { PayCode } from '../payroll/types'

let loading: Promise<PayCode[]> | null = null

export function usePayCodes(): readonly PayCode[] {
  const [codes, setCodes] = useState<readonly PayCode[]>(PAY_CODES)
  useEffect(() => {
    let live = true
    loading ??= getPayCodes().catch((err: unknown) => {
      loading = null
      throw err
    })
    loading.then(
      (rows) => {
        if (live && rows.length > 0) setCodes(rows)
      },
      () => {}, // keep the shipped list; saving still goes through the database's checks
    )
    return () => {
      live = false
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
