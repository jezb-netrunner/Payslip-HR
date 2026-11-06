import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Employee, Profile } from './db'
import { logActivity } from './activity'
import { setSignInNotice } from './authGuard'
import { SESSION_END_NOTICE, SESSION_END_REASON, type SessionEnd } from './useSessionWatch'

interface AuthState {
  session: Session | null
  profile: Profile | null
  /** The signed-in employee's own record (employee logins only). */
  employee: Employee | null
  /** Session check, or the signed-in user's profile not loaded yet. */
  loading: boolean
  /** The profile could not be loaded (network / server error), and none is on hand. */
  profileError: boolean
  isCompanyAdmin: boolean
  isEntityAdmin: boolean
  /** Company or entity admin: may use the admin console. */
  isAdmin: boolean
  isEmployee: boolean
  /** Arrived through a password-reset link: must choose a new password. */
  recovering: boolean
  /** The session's assurance level: aal2 once the second factor (authenticator app) is verified. */
  aal: 'aal1' | 'aal2' | null
  /** aal2 when the account has an authenticator app to verify; aal1 when it has none yet. */
  nextAal: 'aal1' | 'aal2' | null
  refreshAal: () => Promise<void>
  clearRecovery: () => void
  refreshProfile: () => Promise<void>
  /** Signs this device out, on the audit trail (with the reason when the app did it). */
  signOut: (reason?: string) => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  employee: null,
  loading: true,
  profileError: false,
  isCompanyAdmin: false,
  isEntityAdmin: false,
  isAdmin: false,
  isEmployee: false,
  recovering: false,
  aal: null,
  nextAal: null,
  refreshAal: async () => {},
  clearRecovery: () => {},
  refreshProfile: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  // which user the profile state belongs to (loaded or failed)
  const [profileFor, setProfileFor] = useState<string | null>(null)
  const [profileError, setProfileError] = useState(false)
  const [recovering, setRecovering] = useState(false)
  // the assurance level, and the user it was read for (only the first read holds the app back)
  const [assurance, setAssurance] = useState<{ current: AuthState['aal']; next: AuthState['aal']; user: string | null }>({
    current: null,
    next: null,
    user: null,
  })
  const forRef = useRef<string | null>(null)
  // the profile loads several times at start-up (session check, auth event):
  // an ended session is checked and signed out once
  const endingRef = useRef(false)

  async function loadAal(userId: string) {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    setAssurance({ current: (data?.currentLevel as AuthState['aal']) ?? null, next: (data?.nextLevel as AuthState['aal']) ?? null, user: userId })
  }

  // This device only (see signOut below), logged first while the token works
  async function endSession(reason?: string) {
    // a slow network never holds the sign-out up
    await Promise.race([
      logActivity('sign_out', null, reason ? { reason } : {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ])
    await supabase.auth.signOut({ scope: 'local' })
  }

  // Reloads on every auth event (tab refocus, hourly token refresh). A failed
  // load — waking laptop, flaky network, a 5xx — must not throw a working
  // user out: keep what is already loaded for this user and only report an
  // error when there is nothing to show.
  async function loadProfile(userId: string) {
    const settle = (ok: boolean) => {
      forRef.current = userId
      setProfileFor(userId)
      setProfileError(!ok)
    }
    const { data: prof, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    if (error) {
      if (forRef.current !== userId) {
        setProfile(null)
        setEmployee(null)
      }
      return settle(false)
    }
    let emp: Employee | null = null
    if (prof?.role === 'employee' && prof.employee_id) {
      const { data, error: empErr } = await supabase.from('employees').select('*').eq('id', prof.employee_id).maybeSingle()
      if (empErr) {
        if (forRef.current !== userId) {
          setProfile(null)
          setEmployee(null)
        }
        return settle(false)
      }
      emp = (data as Employee) ?? null
      if (!emp) {
        // The database hides an employee's records once the session has ended
        // (idle, past 12 hours, signed out elsewhere) — e.g. a phone tab
        // reopened the next day. Sign out with the reason instead of showing
        // "no access" (the touch also ends the session at Auth).
        if (endingRef.current) return
        endingRef.current = true
        try {
          const { data: st, error: stErr } = await supabase.rpc('touch_employee_session')
          const state = (st as { state?: string } | null)?.state
          if (!stErr && (state === 'idle' || state === 'expired' || state === 'ended')) {
            setSignInNotice(SESSION_END_NOTICE[state as SessionEnd])
            await endSession(SESSION_END_REASON[state as SessionEnd])
            return
          }
        } finally {
          endingRef.current = false
        }
      }
    }
    setProfile((prof as Profile) ?? null)
    setEmployee(emp)
    settle(true)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionChecked(true)
      if (data.session) {
        loadProfile(data.session.user.id)
        void loadAal(data.session.user.id)
      }
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      if (event === 'SIGNED_OUT') setRecovering(false)
      if (sess) {
        // Defer Supabase calls out of the auth callback to avoid deadlocks.
        setTimeout(() => {
          loadProfile(sess.user.id)
          void loadAal(sess.user.id)
        }, 0)
      } else {
        forRef.current = null
        setProfileFor(null)
        setProfileError(false)
        setProfile(null)
        setEmployee(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // never show "no access" screens while the signed-in user's profile is
  // still on its way
  const loading = !sessionChecked || (!!session && (profileFor !== session.user.id || assurance.user !== session.user.id))

  const active = !!profile?.is_active
  const isCompanyAdmin = active && profile?.role === 'company_admin'
  const isEntityAdmin = active && profile?.role === 'entity_admin'

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        employee,
        loading,
        profileError: profileError && !profile,
        isCompanyAdmin,
        isEntityAdmin,
        isAdmin: isCompanyAdmin || isEntityAdmin,
        isEmployee: active && profile?.role === 'employee' && !!employee,
        recovering,
        aal: assurance.current,
        nextAal: assurance.next,
        refreshAal: async () => {
          if (session) await loadAal(session.user.id)
        },
        clearRecovery: () => setRecovering(false),
        refreshProfile: async () => {
          if (session) await loadProfile(session.user.id)
        },
        // This device only. Supabase's default ('global') ends every session of
        // the account — signing out on a phone left the desktop tab with a
        // token the admin-users function rejects as "Not authenticated".
        signOut: endSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
