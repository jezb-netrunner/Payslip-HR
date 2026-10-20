import { useState, type FormEvent } from 'react'
import { Building2, KeyRound, Lock, Mail } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { employeeLoginEmail, isValidLoginCode, normalizeLoginCode } from '../lib/loginCode'
import { Button, Input } from '../components/ui'
import { errorMessage } from '../lib/errors'

type Mode = 'employee' | 'admin' | 'reset' | 'bootstrap'

export default function Login() {
  const [mode, setMode] = useState<Mode>('employee')
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  function switchTo(m: Mode) {
    setMode(m)
    setError('')
    setNotice('')
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'employee') {
        const normalized = normalizeLoginCode(code)
        if (!isValidLoginCode(normalized)) {
          throw new Error('Enter your full login code, including the dash — e.g. ACME-7Q4KX9TB.')
        }
        const { error: err } = await supabase.auth.signInWithPassword({
          email: await employeeLoginEmail(normalized),
          password: normalized,
        })
        if (err) throw new Error('That code did not work. Check it with your HR or payroll officer.')
      } else if (mode === 'admin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      } else if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
        })
        if (err) throw err
        setNotice('If that address belongs to an admin account, a password reset link is on its way.')
      } else {
        const { error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        setNotice(
          'Account created. Confirm the email if confirmation is enabled, then sign in. Only the very first account of a new deployment becomes the company admin.',
        )
      }
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed'))
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
              HR &amp; Payroll for PH employers
            </p>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-7 shadow-2xl">
          {(mode === 'employee' || mode === 'admin') && (
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              {(['employee', 'admin'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchTo(m)}
                  className={`rounded-lg py-1.5 text-sm font-semibold ${
                    mode === m ? 'bg-white text-brand-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {m === 'employee' ? 'Employee' : 'Admin'}
                </button>
              ))}
            </div>
          )}
          <h2 className="text-lg font-bold text-brand-900">
            {mode === 'employee' && 'Sign in with your code'}
            {mode === 'admin' && 'Admin sign in'}
            {mode === 'reset' && 'Reset your password'}
            {mode === 'bootstrap' && 'Set up a new deployment'}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {mode === 'employee' && 'Use the login code given to you by your HR or payroll officer.'}
            {mode === 'admin' && 'For company admins and client payroll/HR staff.'}
            {mode === 'reset' && 'Admins only — employees get a new code from their payroll officer.'}
            {mode === 'bootstrap' &&
              'The first account ever created becomes the company admin. Every other account is created from inside the app.'}
          </p>
          <form onSubmit={submit} className="mt-5 space-y-4">
            {mode === 'employee' ? (
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 size-4 text-slate-400" />
                <Input
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ACME-7Q4KX9TB"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="pl-9 font-mono tracking-wider uppercase"
                />
              </div>
            ) : (
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
            )}
            {(mode === 'admin' || mode === 'bootstrap') && (
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
            )}
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
            {notice && (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy
                ? 'Please wait…'
                : mode === 'reset'
                  ? 'Send reset link'
                  : mode === 'bootstrap'
                    ? 'Create company admin account'
                    : 'Sign in'}
            </Button>
          </form>
          <div className="mt-4 flex justify-between text-xs font-semibold text-brand-600">
            {mode === 'admin' && (
              <>
                <button onClick={() => switchTo('reset')} className="hover:text-brand-800">
                  Forgot password?
                </button>
                <button onClick={() => switchTo('bootstrap')} className="text-slate-400 hover:text-brand-800">
                  New deployment?
                </button>
              </>
            )}
            {(mode === 'reset' || mode === 'bootstrap') && (
              <button onClick={() => switchTo('admin')} className="hover:text-brand-800">
                ← Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
