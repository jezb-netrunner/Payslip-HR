import { useEffect, useRef } from 'react'
import { supabase } from './supabase'
import { passwordChangeUnderWay } from './authGuard'

/** The access token in use now (the session it belongs to). */
async function currentToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * One active admin session (BIR RMO 9-2021 Annex B): a sign-in elsewhere, or
 * a revocation, ends this session, and the database stops answering it as an
 * admin at once. Checked on load, every minute and whenever the tab comes
 * back; `onEnded` runs once when it has ended. A failed check (offline, the
 * server busy) never signs anyone out.
 */
export function useSessionWatch(enabled: boolean, onEnded: () => void): void {
  const ended = useRef(onEnded)
  useEffect(() => {
    ended.current = onEnded
  })
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let checking = false
    const check = async () => {
      if (stopped || checking || document.visibilityState === 'hidden' || passwordChangeUnderWay()) return
      checking = true
      try {
        const before = await currentToken()
        const { data, error } = await supabase.rpc('my_session_active')
        // the answer is about the session it was asked with: a password change
        // or a refresh in between gets the next check instead
        if (stopped || error || data !== false || passwordChangeUnderWay() || (await currentToken()) !== before) return
        stopped = true
        ended.current()
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(check, 60_000)
    const onShow = () => void check()
    window.addEventListener('focus', onShow)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onShow)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [enabled])
}
