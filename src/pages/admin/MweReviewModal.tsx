// The minimum wage earner status review for one client (owner's answer to
// the spec T12 question, 2026-10-25): MWE status now follows the pay rate,
// so before the first payroll on the new rule admins see whose status
// changes and what the year-end adjustment will do to their tax, warn the
// employees who will owe catch-up tax, and mark the list reviewed.

import { useEffect, useState } from 'react'
import { Badge, Button, LoadFailed, Modal, PendingBadge, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Entity } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { money, plural } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { loadMweReview, type MweReviewResult } from '../../payroll/mweReviewData'

const statusLabel = (mwe: boolean) => (mwe ? <Badge tone="orange">MWE</Badge> : <span className="text-xs text-slate-500">not MWE</span>)

export default function MweReviewModal({ entity, onClose, onReviewed }: { entity: Entity; onClose: () => void; onReviewed: () => Promise<void> }) {
  const toast = useToast()
  const year = Number(todayManila().slice(0, 4))
  const [result, setResult] = useState<MweReviewResult | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    loadMweReview(entity, year).then(
      (r) => {
        if (live) setResult(r)
      },
      (err: unknown) => {
        if (live) setLoadError(errorMessage(err, 'Could not load the review'))
      },
    )
    return () => {
      live = false
    }
  }, [entity, year, attempt])

  const changed = (result?.rows ?? []).filter((r) => r.before !== r.now)

  /** The status now becomes the status last reviewed: the list drops them until it changes again. */
  async function markReviewed() {
    setBusy(true)
    try {
      for (const now of [true, false]) {
        const ids = changed.filter((r) => r.now === now).map((r) => r.employeeId)
        if (ids.length === 0) continue
        const { error } = await supabase.from('employees').update({ is_minimum_wage_earner: now }).eq('entity_id', entity.id).in('id', ids)
        if (error) throw error
      }
      toast('success', `${plural(changed.length, 'employee')} marked as reviewed.`)
      await onReviewed()
      onClose()
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Minimum wage earner status — ${entity.name}`} wide>
      {loadError ? (
        <LoadFailed
          message={loadError}
          onRetry={() => {
            setLoadError('')
            setAttempt((n) => n + 1)
          }}
        />
      ) : !result ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-slate-600">
            Minimum wage earner (MWE) status now follows the pay rate: an employee paid at or below the minimum wage in force is
            an MWE for that payroll (RR 2-98 Sec. 2.78.1(B)(13)). Listed: the employees whose status now differs from the status
            last set (the old MWE checkbox) or reviewed, and those whose payslips this year the year-end adjustment will treat
            under the other status.
          </p>
          {!result.rateOnFile && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No minimum wage on file for {entity.minimum_wage_region || "the client's region"} today, so the status comes from the
              client's own setting. Before the first payroll on the new rule, a company admin enters the region's wage orders under
              Statutory Tables → Minimum wages.
            </p>
          )}
          {result.untested > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {plural(result.untested, 'payslip')} this year {result.untested === 1 ? 'has' : 'have'} no minimum wage on file for
              {result.untested === 1 ? ' its' : ' their'} period, so the year-end adjustment can't re-test{' '}
              {result.untested === 1 ? 'it' : 'them'}: enter every wage order in force this year.
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            Apprentices and learners paid below the minimum wage (at least 75% of it):{' '}
            {result.apprenticeMwe ? 'treated as MWEs' : 'not treated as MWEs'} (the apprentice rule, Statutory Tables).
            <PendingBadge />
          </p>
          {result.rows.length === 0 ? (
            <p className="text-slate-500">No employee changes status, and no payslip this year changes on re-test.</p>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th className="text-right">Daily rate</Th>
                  <Th>Was</Th>
                  <Th>Now</Th>
                  <Th className="text-right">Payslips re-tested</Th>
                  <Th>At the year-end adjustment</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.employeeId}>
                    <Td className="font-semibold">{r.name}</Td>
                    <Td className="text-right">{money(r.daily)}</Td>
                    <Td>{statusLabel(r.before)}</Td>
                    <Td>{statusLabel(r.now)}</Td>
                    <Td className="text-right">{r.retested || '—'}</Td>
                    <Td className="text-xs">
                      {r.taxChange > 0 ? (
                        <span className="font-semibold text-rose-700">about {money(r.taxChange)} more tax</span>
                      ) : r.taxChange < 0 ? (
                        <span className="font-semibold text-emerald-700">about {money(-r.taxChange)} refunded</span>
                      ) : (
                        'no change in tax so far'
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
          <p className="text-xs text-slate-500">
            Warn the employees who will owe more tax. The year-end adjustment takes it from the last pay of the year, after the
            contributions and union dues and before loans; what that pay can't cover the employer pays, as an advance the employee
            repays. The amounts count this year's pay so far (and a previous employer's), not the months still to come.
          </p>
          <div className="flex flex-wrap gap-2">
            {changed.length > 0 && (
              <Button onClick={markReviewed} disabled={busy}>
                Mark {plural(changed.length, 'status change')} as reviewed
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
