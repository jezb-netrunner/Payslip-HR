import { useCallback } from 'react'
import { useAuth } from './auth'
import { useEntity } from './entity'
import { makeStamp, type ReportStamp, type StampCompany } from './reportStamp'

/** The identification of a report generated now by the signed-in user, for the given client (else the selected one). */
export function useReportStamp(client?: StampCompany | null): (title: string) => ReportStamp {
  const { profile } = useAuth()
  const { entity } = useEntity()
  const company = client ?? entity
  return useCallback((title: string) => makeStamp(title, company, profile), [company, profile])
}
