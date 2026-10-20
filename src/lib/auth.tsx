import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Employee, Profile } from './db'

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
  clearRecovery: () => void
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
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
  const forRef = useRef<string | null>(null)

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
    }
    setProfile((prof as Profile) ?? null)
    setEmployee(emp)
    settle(true)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionChecked(true)
      if (data.session) loadProfile(data.session.user.id)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      if (event === 'SIGNED_OUT') setRecovering(false)
      if (sess) {
        // Defer Supabase calls out of the auth callback to avoid deadlocks.
        setTimeout(() => loadProfile(sess.user.id), 0)
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
  const loading = !sessionChecked || (!!session && profileFor !== session.user.id)

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
        clearRecovery: () => setRecovering(false),
        refreshProfile: async () => {
          if (session) await loadProfile(session.user.id)
        },
        signOut: async () => {
          await supabase.auth.signOut()
        },
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
