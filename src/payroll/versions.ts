// Picks the statutory table versions in force on a date from the
// `statutory_versions` rows (the database is the source of truth; see
// getStatutoryTables in src/lib/api.ts, which loads the rows).

import type {
  BirAnnualData,
  BirWhtData,
  DeMinimisData,
  PagibigData,
  PhilHealthData,
  SssTableData,
  StatutoryKind,
  StatutoryTables,
  StatutoryVersionRow,
} from './types'

// Basis (de minimis ceilings by pay date): RR 2-98 §2.78.1(A)(3), as amended by RR 29-2025 §1 (dated Oct 27, 2025; BIR CDN).
/**
 * For each kind, the newest version with `effective_from <= asOf`. The
 * contribution, withholding and annual tables are required; the de minimis
 * ceilings are optional (none are on file for pay dated before 2026-01-07).
 */
export function pickStatutoryTables(rows: readonly StatutoryVersionRow[], asOf: string): StatutoryTables {
  const pick = (kind: StatutoryKind) =>
    rows
      .filter((r) => r.kind === kind && r.effective_from <= asOf)
      .reduce<StatutoryVersionRow | undefined>((best, r) => (!best || r.effective_from > best.effective_from ? r : best), undefined)?.data
  const sss = pick('sss') as SssTableData | undefined
  const philhealth = pick('philhealth') as PhilHealthData | undefined
  const pagibig = pick('pagibig') as PagibigData | undefined
  const bir_wht = pick('bir_wht') as BirWhtData | undefined
  const bir_annual = pick('bir_annual') as BirAnnualData | undefined
  const de_minimis = pick('de_minimis') as DeMinimisData | undefined
  if (!sss || !philhealth || !pagibig || !bir_wht || !bir_annual) {
    throw new Error(
      'Statutory tables are incomplete for ' + asOf + '. The missing table version has to be published by the system maintainer (statutory tables ship with the software).',
    )
  }
  return { sss, philhealth, pagibig, bir_wht, bir_annual, ...(de_minimis ? { de_minimis } : {}) }
}
