import { useState, type FormEvent } from 'react'
import { Check, KeyRound, Lock, Mail, User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { employeeLoginEmail, isValidLoginCode, normalizeLoginCode } from '../lib/loginCode'
import { Button, Input, Logo } from '../components/ui'
import { errorMessage } from '../lib/errors'

type Mode = 'employee' | 'admin' | 'reset' | 'bootstrap'

/**
 * A rejected code and a busy or unreachable server need different advice:
 * on payday many employees sign in from one office IP and can hit the
 * sign-in rate limit with a perfectly good code.
 */
function signInProblem(err: { status?: number; name?: string }, badCredentials: string): string {
  if (err.status === 429) return 'Too many sign-in attempts from this network. Wait a few minutes, then try again.'
  if (err.name === 'AuthRetryableFetchError' || !err.status || err.status >= 500) {
    return "Can't reach the server right now. Check your connection and try again."
  }
  return badCredentials
}

export default function Login() {
  const [mode, setMode] = useState<Mode>('employee')
  const [code, setCode] = useState('')
  const [fullName, setFullName] = useState('')
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
        if (err) throw new Error(signInProblem(err, 'That code did not work. Check it with your HR or payroll officer.'))
      } else if (mode === 'admin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw new Error(signInProblem(err, err.message))
      } else if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
        })
        if (err) throw err
        setNotice('If that address belongs to an admin account, a password reset link is on its way.')
      } else {
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName.trim() } },
        })
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
    <div className="flex min-h-screen bg-canvas">
      <aside className="relative hidden w-[44%] max-w-[640px] flex-col justify-between overflow-hidden bg-ink-900 p-10 text-white lg:flex">
        <Logo />
        <div className="relative z-10">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-accent-400">
            <span className="size-1.5 rounded-full bg-accent-400" /> HR &amp; payroll for PH employers
          </p>
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            Time, leave and payroll
            <br />
            in one place.
          </h1>
          <p className="mt-4 max-w-md text-base text-white/60">
            Admins enter time in/out and run payroll with SSS, PhilHealth, Pag-IBIG and BIR withholding. Employees
            sign in with a code to see their payslips and file leave.
          </p>
          <div aria-hidden="true" className="mt-10 max-w-sm rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-leaf-400 text-ink-900">
                <Check className="size-5" strokeWidth={3} />
              </span>
              <div>
                <p className="text-sm font-semibold">Payroll finalized</p>
                <p className="text-xs text-white/50">Payslips are ready for every employee</p>
              </div>
            </div>
            <div className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
              <span className="w-[62%] bg-brand-400" />
              <span className="w-[24%] bg-work" />
              <span className="w-[14%] bg-accent-400" />
            </div>
            <div className="mt-2 flex gap-4 text-[11px] text-white/50">
              <span>Regular</span>
              <span>Overtime</span>
              <span>Holiday</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-white/40">Asia/Manila · Philippine labor and tax rules</p>
        <span aria-hidden="true" className="absolute -right-24 -top-24 size-72 rounded-full bg-accent-400/10" />
        <span aria-hidden="true" className="absolute -bottom-32 -right-10 size-96 rounded-full bg-brand-500/15" />
      </aside>
      <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo dark />
          </div>
          <div className="rounded-2xl border border-slate-200/80 bg-white p-7 shadow-sm sm:p-8">
          {(mode === 'employee' || mode === 'admin') && (
            <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              {(['employee', 'admin'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchTo(m)}
                  className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                    mode === m ? 'bg-ink-900 text-white shadow-sm' : 'text-slate-500 hover:text-ink-900'
                  }`}
                >
                  {m === 'employee' ? 'Employee' : 'Admin'}
                </button>
              ))}
            </div>
          )}
          <h2 className="text-xl font-bold text-ink-900">
            {mode === 'employee' && 'Sign in with your code'}
            {mode === 'admin' && 'Admin sign in'}
            {mode === 'reset' && 'Reset your password'}
            {mode === 'bootstrap' && 'Set up a new deployment'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'employee' && 'Use the login code given to you by your HR or payroll officer.'}
            {mode === 'admin' && 'For company admins and client payroll/HR staff.'}
            {mode === 'reset' && 'Admins only — employees get a new code from their payroll officer.'}
            {mode === 'bootstrap' &&
              'The first account ever created becomes the company admin. Every other account is created from inside the app.'}
          </p>
          <form onSubmit={submit} className="mt-5 space-y-4">
            {mode === 'bootstrap' && (
              <div className="relative">
                <User className="absolute left-3 top-2.5 size-4 text-slate-400" />
                <Input
                  required
                  aria-label="Full name"
                  autoComplete="name"
                  placeholder="Full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="pl-9"
                />
              </div>
            )}
            {mode === 'employee' ? (
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 size-4 text-slate-400" />
                <Input
                  required
                  aria-label="Login code"
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
                  aria-label="Email"
                  autoComplete="email"
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
                  aria-label="Password"
                  autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
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
                <button type="button" onClick={() => switchTo('reset')} className="hover:text-brand-800">
                  Forgot password?
                </button>
                <button type="button" onClick={() => switchTo('bootstrap')} className="text-slate-400 hover:text-brand-800">
                  New deployment?
                </button>
              </>
            )}
            {(mode === 'reset' || mode === 'bootstrap') && (
              <button type="button" onClick={() => switchTo('admin')} className="hover:text-brand-800">
                ← Back to sign in
              </button>
            )}
          </div>
          </div>
        </div>
      </main>
    </div>
  )
}
