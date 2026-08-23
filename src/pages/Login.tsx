import { useState, type FormEvent } from 'react'
import { Building2, Lock, Mail } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { Button, Input } from '../components/ui'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [signupMode, setSignupMode] = useState(false)
  const [notice, setNotice] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (signupMode) {
        const { error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        setNotice(
          'Account created. If email confirmation is enabled you must confirm before signing in; otherwise you are now signed in. The first account in the system becomes the administrator.',
        )
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-950 via-brand-900 to-brand-800 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-white/10">
            <Building2 className="size-6 text-accent-400" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white">Payslip HR</h1>
            <p className="text-xs font-medium uppercase tracking-widest text-brand-300">
              HR &amp; Payroll for PH MSMEs
            </p>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-7 shadow-2xl">
          <h2 className="text-lg font-bold text-brand-900">
            {signupMode ? 'Set up the first account' : 'Sign in'}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {signupMode
              ? 'The first account created becomes the administrator. Employees are invited by the admin afterwards.'
              : 'Use the account provided by your administrator.'}
          </p>
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 size-4 text-slate-400" />
              <Input
                type="email"
                required
                placeholder="you@company.ph"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 size-4 text-slate-400" />
              <Input
                type="password"
                required
                minLength={8}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-9"
              />
            </div>
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
            {notice && (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Please wait…' : signupMode ? 'Create admin account' : 'Sign in'}
            </Button>
          </form>
          <button
            onClick={() => {
              setSignupMode(!signupMode)
              setError('')
              setNotice('')
            }}
            className="mt-4 w-full text-center text-xs font-semibold text-brand-600 hover:text-brand-800"
          >
            {signupMode ? '← Back to sign in' : 'First time here? Create the admin account'}
          </button>
        </div>
        <p className="mt-4 text-center text-[11px] text-brand-300">
          Time punches are verified with selfies, device and location checks.
        </p>
      </div>
    </div>
  )
}
