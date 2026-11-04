import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { errorMessage } from '../lib/errors'
import { fmtDateTime } from '../lib/format'
import { useToast } from './toast'
import { Button, Field, Input, Spinner } from './ui'

// Two-step sign-in for admins: an authenticator app (TOTP) after the
// password. The database gives admin access only to a session that has
// verified it (aal2), so a password alone — even after a reset link — opens
// nothing. Supabase Auth refuses to add or remove an authenticator from a
// password-only session once the account has one.

interface Enrolment {
  id: string
  qr: string
  secret: string
}

/** Starts a new authenticator, clearing any left half-done (one would block the next). */
async function startEnrolment(): Promise<Enrolment> {
  const { data: listed } = await supabase.auth.mfa.listFactors()
  for (const f of (listed?.all ?? []) as Factor[]) {
    if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  })
  if (error) throw error
  return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }
}

interface Factor {
  id: string
  friendly_name?: string | null
  status: string
  created_at: string
}

/** The QR code as an image source (Supabase gives the SVG itself). */
function qrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`
}

function CodeInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Input
      aria-label="6-digit code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      className="text-center font-mono text-lg tracking-[0.4em]"
    />
  )
}

/** Sets up an authenticator app: scan the QR code (or type the key), then confirm with a code. */
export function EnrollAuthenticator({ onEnrolled, onCancel }: { onEnrolled: () => void; onCancel?: () => void }) {
  const [enrolled, setEnrolled] = useState<Enrolment | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // one enrolment per mount, even when an effect runs twice (React's strict mode)
  const started = useRef<Promise<Enrolment> | null>(null)

  useEffect(() => {
    let stale = false
    started.current ??= startEnrolment()
    started.current.then(
      (e) => {
        if (!stale) setEnrolled(e)
      },
      (err) => {
        if (!stale) setError(errorMessage(err, 'Could not start setting up the authenticator app'))
      },
    )
    return () => {
      stale = true
    }
  }, [])

  async function confirm(e: FormEvent) {
    e.preventDefault()
    if (!enrolled || code.length !== 6) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolled.id, code })
    setBusy(false)
    if (err) {
      setError(err.message.includes('Invalid') ? 'That code is not right. Check the time on your phone and try the newest code.' : err.message)
      return
    }
    onEnrolled()
  }

  if (error && !enrolled) return <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>
  if (!enrolled) return <Spinner />
  return (
    <form onSubmit={confirm} className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy or 1Password).</li>
        <li>Scan this QR code, or type the key below.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex justify-center">
        <img src={qrSrc(enrolled.qr)} alt="QR code for the authenticator app" className="size-44 rounded-lg border border-slate-200 bg-white p-2" />
      </div>
      <p className="break-all text-center font-mono text-xs text-slate-500" aria-label="Key for the authenticator app">
        {enrolled.secret}
      </p>
      <CodeInput value={code} onChange={setCode} disabled={busy} />
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="flex-1" disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Turn on two-step sign-in'}
        </Button>
      </div>
    </form>
  )
}

/** After the password: the authenticator code, or setting one up (admins must). */
export function MfaGate() {
  const { nextAal, refreshAal, signOut } = useAuth()
  const [factors, setFactors] = useState<Factor[] | null>(null)
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    supabase.auth.mfa.listFactors().then(({ data }) => {
      if (stale) return
      const verified = ((data?.totp ?? []) as Factor[]).filter((f) => f.status === 'verified')
      setFactors(verified)
      setFactorId(verified[0]?.id ?? '')
    })
    return () => {
      stale = true
    }
  }, [nextAal])

  async function verify(e: FormEvent) {
    e.preventDefault()
    if (!factorId || code.length !== 6) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
    setBusy(false)
    if (err) {
      setError(err.message.includes('Invalid') ? 'That code is not right. Try the newest code in your app.' : err.message)
      setCode('')
      return
    }
    await refreshAal()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <h1 className="flex items-center gap-2 text-lg font-bold text-ink-900">
          <ShieldCheck className="size-5 text-brand-700" /> Two-step sign-in
        </h1>
        {factors === null ? (
          <Spinner />
        ) : factors.length > 0 ? (
          <form onSubmit={verify} className="mt-3 space-y-4">
            <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app.</p>
            {factors.length > 1 && (
              <Field label="Authenticator">
                <select
                  value={factorId}
                  onChange={(e) => setFactorId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  {factors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.friendly_name || 'Authenticator'}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <CodeInput value={code} onChange={setCode} disabled={busy} />
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
            <p className="text-xs text-slate-500">Lost your phone? A company admin can reset your two-step sign-in (Admin Users).</p>
          </form>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-600">
              Admin accounts need a second step after the password: a code from an authenticator app on your phone. Set
              it up once; each sign-in then asks for the current code.
            </p>
            <EnrollAuthenticator onEnrolled={() => void refreshAal()} />
          </div>
        )}
        <button type="button" onClick={() => void signOut()} className="mt-5 text-sm font-semibold text-brand-600 hover:text-brand-800">
          Cancel and sign out
        </button>
      </div>
    </div>
  )
}

/** Account menu: the account's authenticator apps — add another phone, remove one (never the last). */
export function TwoStepSettings() {
  const toast = useToast()
  const [factors, setFactors] = useState<Factor[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const load = () => setTick((t) => t + 1)

  useEffect(() => {
    let stale = false
    supabase.auth.mfa.listFactors().then(({ data }) => {
      if (!stale) setFactors(((data?.totp ?? []) as Factor[]).filter((f) => f.status === 'verified'))
    })
    return () => {
      stale = true
    }
  }, [tick])

  async function remove(f: Factor) {
    if (!confirm(`Remove ${f.friendly_name || 'this authenticator'}? Its codes stop working.`)) return
    setBusy(f.id)
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id })
    setBusy(null)
    if (error) return toast('error', errorMessage(error, 'Could not remove it'))
    toast('success', 'Authenticator removed.')
    load()
  }

  if (factors === null) return <Spinner />
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Each sign-in asks for a code from one of these apps. Add a second phone so a lost one doesn&apos;t lock you out.
      </p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {factors.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <Smartphone className="size-4 shrink-0 text-slate-400" />
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink-900">{f.friendly_name || 'Authenticator'}</span>
                <span className="block text-xs text-slate-500">Added {fmtDateTime(f.created_at)}</span>
              </span>
            </span>
            <button
              type="button"
              disabled={factors.length < 2 || busy === f.id}
              title={factors.length < 2 ? 'Add another authenticator before removing this one' : 'Remove'}
              aria-label={`Remove ${f.friendly_name || 'authenticator'}`}
              onClick={() => remove(f)}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-rose-600 disabled:opacity-40"
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <EnrollAuthenticator
          onCancel={() => setAdding(false)}
          onEnrolled={() => {
            setAdding(false)
            toast('success', 'Authenticator added.')
            load()
          }}
        />
      ) : (
        <Button variant="secondary" className="w-full" onClick={() => setAdding(true)}>
          <Smartphone className="size-4" /> Add another authenticator
        </Button>
      )}
    </div>
  )
}
