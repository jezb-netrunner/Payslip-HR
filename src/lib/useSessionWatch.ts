import { useEffect, useRef } from 'react'
import { supabase } from './supabase'

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
      if (stopped || checking || document.visibilityState === 'hidden') return
      checking = true
      try {
        const { data, error } = await supabase.rpc('my_session_active')
        if (!stopped && !error && data === false) {
          stopped = true
          ended.current()
        }
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
