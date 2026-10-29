import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { guardSetPassword } from '../lib/authGuard'
import { PASSWORD_RULE, passwordProblem } from '../lib/password'
import { useToast } from './toast'
import { Button, Field, Input } from './ui'

/**
 * Admin self-service password change, through the sign-in guard (the
 * password rules, and the new password starts the one active session). A
 * reset link proves the mailbox: `recovery` asks for no current password.
 */
export default function ChangePassword({ recovery = false, onDone }: { recovery?: boolean; onDone?: () => void }) {
  const toast = useToast()
  const { profile, clearRecovery } = useAuth()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!recovery && !current) return toast('error', 'Enter your current password.')
    const problem = passwordProblem(pw, profile?.email ?? '')
    if (problem) return toast('error', problem)
    if (pw !== confirm) return toast('error', 'The passwords do not match.')
    if (!recovery && pw === current) return toast('error', 'Choose a password different from the current one.')
    setBusy(true)
    try {
      await guardSetPassword(pw, recovery ? undefined : current)
    } catch (err) {
      setBusy(false)
      return toast('error', err instanceof Error ? err.message : 'Could not change the password.')
    }
    setBusy(false)
    toast('success', 'Password updated. Other sessions of this account were signed out.')
    setCurrent('')
    setPw('')
    setConfirm('')
    clearRecovery()
    onDone?.()
  }

  return (
    <div className="space-y-3">
      {!recovery && (
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
      )}
      <Field label="New password" hint={PASSWORD_RULE}>
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password">
        <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      <Button className="w-full" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Update password'}
      </Button>
    </div>
  )
}
