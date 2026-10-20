import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { useToast } from './toast'
import { Button, Field, Input } from './ui'

/** Admin self-service password change (also finishes a reset-link recovery). */
export default function ChangePassword({ onDone }: { onDone?: () => void }) {
  const toast = useToast()
  const { clearRecovery } = useAuth()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (pw.length < 8) return toast('error', 'Use at least 8 characters.')
    if (pw !== confirm) return toast('error', 'The passwords do not match.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return toast('error', error.message)
    toast('success', 'Password updated.')
    setPw('')
    setConfirm('')
    clearRecovery()
    onDone?.()
  }

  return (
    <div className="space-y-3">
      <Field label="New password (min 8 characters)">
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
