import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { passwordChangeUnderWay } from './authGuard'

/** Minutes without activity before the app signs out (the database ends an admin session at 32). */
export const IDLE_MINUTES = 30
const WARN_MINUTES = 25
const ACTIVITY_KEY = 'payslip-hr:last-activity'

/** Why a session ended: replaced or revoked, idle, or past its 12 hours. */
export type SessionEnd = 'ended' | 'idle' | 'expired'

/**
 * The last activity in any of the app's tabs on this session (one busy tab
 * keeps the others signed in). Only this device's clock is compared with
 * itself — a device clock set wrong never ends a session by itself.
 */
function storedActivity(session: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? 'null') as { at?: unknown; session?: unknown } | null
    return v?.session === session && typeof v.at === 'number' ? v.at : 0
  } catch {
    return 0
  }
}

function shareActivity(session: string, at: number): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify({ session, at }))
  } catch {
    // storage blocked: this tab keeps its own clock
  }
}

/** The Auth session a token belongs to (kept across token refreshes). */
export function sessionOf(token: string | null | undefined): string {
  try {
    const claims = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: unknown }
    return typeof claims.session_id === 'string' ? claims.session_id : ''
  } catch {
    return ''
  }
}

/** The access token in use now (the session it belongs to). */
async function currentToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * Session timeouts (NIST SP 800-63B, OWASP): everyone is signed out after 30
 * minutes without activity, warned from 25. For an admin the database keeps
 * the clock too — the app reports activity (at most once a minute) and reads
 * the session's state every minute, on focus and on return to the tab: a
 * sign-in elsewhere, a revocation, idling or the 12-hour limit ends it.
 * Opening the app counts as activity, unless it comes back to a session idle
 * for 30 minutes already (a closed browser, a sleeping laptop) — that one
 * ends. `onEnded` runs once. A failed check (offline, the server busy) never
 * signs anyone out.
 */
export function useSessionWatch(opts: {
  enabled: boolean
  admin: boolean
  /** The Auth session (`sessionOf`): activity stored by an earlier one doesn't count. */
  session: string
  onEnded: (why: SessionEnd) => void
}): {
  secondsLeft: number | null
  stay: () => void
} {
  const { enabled, admin, session } = opts
  const ended = useRef(opts.onEnded)
  useEffect(() => {
    ended.current = opts.onEnded
  })
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const activity = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    const opened = Date.now()
    const before = storedActivity(session)
    if (before && opened - before >= IDLE_MINUTES * 60_000) {
      ended.current('idle')
      return
    }
    let stopped = false
    let checking = false
    let local = opened
    let shared = opened
    let touched = opened
    shareActivity(session, opened)

    const end = (why: SessionEnd) => {
      if (stopped) return
      stopped = true
      setSecondsLeft(null)
      ended.current(why)
    }

    const ready = () => !stopped && !checking && !passwordChangeUnderWay()
    const settle = async (ask: () => PromiseLike<{ data: unknown; error: unknown }>) => {
      if (!ready()) return
      checking = true
      try {
        const token = await currentToken()
        const { data, error } = await ask()
        const state = (data as { state?: string } | null)?.state
        // the answer is about the session it was asked with: a password change
        // or a refresh in between gets the next check instead
        if (stopped || error || !state || state === 'active' || passwordChangeUnderWay() || (await currentToken()) !== token) return
        end(state === 'idle' || state === 'expired' ? state : 'ended')
      } finally {
        checking = false
      }
    }
    const touch = () => supabase.rpc('touch_admin_session')
    const check = () => {
      if (admin && document.visibilityState !== 'hidden') void settle(() => supabase.rpc('my_session_state'))
    }

    activity.current = () => {
      const now = Date.now()
      local = now
      if (now - shared > 5_000) {
        shared = now
        shareActivity(session, now)
      }
      if (admin && now - touched > 60_000 && ready()) {
        touched = now
        void settle(touch)
      }
    }
    const onActivity = () => activity.current()
    const onShow = () => {
      if (document.visibilityState !== 'hidden') check()
    }

    const ticker = window.setInterval(() => {
      const idle = Date.now() - Math.max(local, storedActivity(session))
      if (idle >= IDLE_MINUTES * 60_000) end('idle')
      else setSecondsLeft(idle >= WARN_MINUTES * 60_000 ? Math.ceil((IDLE_MINUTES * 60_000 - idle) / 1000) : null)
    }, 1000)
    const poller = window.setInterval(check, 60_000)
    if (admin) void settle(touch)
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const
    for (const e of events) window.addEventListener(e, onActivity, { passive: true })
    window.addEventListener('focus', onShow)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      stopped = true
      window.clearInterval(ticker)
      window.clearInterval(poller)
      for (const e of events) window.removeEventListener(e, onActivity)
      window.removeEventListener('focus', onShow)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [enabled, admin, session])

  return { secondsLeft, stay: () => activity.current() }
}
