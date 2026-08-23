import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Employee, Profile } from './db'

interface AuthState {
  session: Session | null
  profile: Profile | null
  employee: Employee | null
  loading: boolean
  isAdmin: boolean
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  employee: null,
  loading: true,
  isAdmin: false,
  refreshProfile: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadProfile(userId: string) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    setProfile((prof as Profile) ?? null)
    if (prof?.employee_id) {
      const { data: emp } = await supabase
        .from('employees')
        .select('*')
        .eq('id', prof.employee_id)
        .maybeSingle()
      setEmployee((emp as Employee) ?? null)
    } else {
      setEmployee(null)
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) {
        loadProfile(data.session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      if (sess) {
        // Defer Supabase calls out of the auth callback to avoid deadlocks.
        setTimeout(() => loadProfile(sess.user.id), 0)
      } else {
        setProfile(null)
        setEmployee(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        employee,
        loading,
        isAdmin: profile?.role === 'admin' && profile.is_active,
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
