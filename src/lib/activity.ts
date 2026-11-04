// Report runs, sign-ins and sign-outs on the audit trail (BIR RMO 9-2021
// Annex B: an activity log of what is done in the system). Fire and forget:
// a report is never held back by its log line.

import { supabase } from './supabase'

export type Activity = 'report' | 'print' | 'export' | 'sign_in' | 'sign_out'

export function logActivity(action: Activity, entityId: string | null, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  return Promise.resolve(supabase.rpc('log_activity', { p_action: action, p_entity: entityId, p_detail: detail })).then(
    ({ error }) => {
      if (error) console.warn('activity log:', error.message)
    },
    () => {},
  )
}
