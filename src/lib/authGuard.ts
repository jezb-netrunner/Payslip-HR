// Admin sign-in through the auth-guard edge function (BIR RMO 9-2021 Annex B,
// system security): it locks an account after five failed sign-ins, admits
// one session at a time (the only one with admin access) and makes a
// temporary or 30-day-old password be changed first. The session it returns
// becomes the app's session.

import type { Session } from '@supabase/supabase-js'
import { edgeFunctionUrl } from './api'
import { supabase } from './supabase'
import { manilaStamp } from './reportStamp'

export type SignInOutcome = { kind: 'signed_in' } | { kind: 'change_password'; reason: 'new' | 'expired' }

interface GuardPayload {
  status?: 'ok' | 'password_change_required'
  session?: Session
  reason?: 'new' | 'expired'
  error?: string
  message?: string
  locked_until?: string
}

const OFFLINE = "Can't reach the server right now. Check your connection and try again."

/** What the person is told for a refused sign-in or password change. */
export function guardProblem(status: number, p: GuardPayload): string {
  switch (p.error) {
    case 'locked':
      return `Too many failed sign-ins: this account is locked until ${p.locked_until ? manilaStamp(new Date(p.locked_until)) : 'later'}. A company admin can unlock it sooner.`
    case 'invalid':
      return 'Wrong email or password. Five failed sign-ins in a row lock the account for 30 minutes.'
    case 'deactivated':
      return 'This account is deactivated or locked. Ask a company admin.'
    case 'rate_limited':
      return 'Too many sign-in attempts from this network. Wait a few minutes, then try again.'
    case 'not_admin':
      return 'This is not an admin account. Employees sign in with their login code.'
    case 'weak_password':
      return p.message ?? 'Choose a stronger password.'
  }
  if (!status || status >= 500) return OFFLINE
  return p.error ?? 'Sign-in failed.'
}

async function post(body: Record<string, unknown>, token?: string): Promise<GuardPayload> {
  let res: Response
  try {
    res = await fetch(edgeFunctionUrl('auth-guard'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(OFFLINE)
  }
  let payload: GuardPayload = {}
  try {
    payload = await res.json()
  } catch {
    // a gateway error page
  }
  if (!res.ok || payload.error) throw new Error(guardProblem(res.status, payload))
  return payload
}

/** The session the guard admitted becomes the app's session. */
async function adopt(p: GuardPayload): Promise<void> {
  if (!p.session) throw new Error('Sign-in failed.')
  const { error } = await supabase.auth.setSession({ access_token: p.session.access_token, refresh_token: p.session.refresh_token })
  if (error) throw error
}

export async function guardSignIn(email: string, password: string): Promise<SignInOutcome> {
  const p = await post({ action: 'sign_in', email, password })
  if (p.status === 'password_change_required') return { kind: 'change_password', reason: p.reason ?? 'new' }
  await adopt(p)
  return { kind: 'signed_in' }
}

/** Before a session: the current password, then the new one (signs in with it). */
export async function guardChangePassword(email: string, password: string, newPassword: string): Promise<void> {
  await adopt(await post({ action: 'change_password', email, password, new_password: newPassword }))
}

/** Signed in (or arrived through a reset link, which needs no current password). */
export async function guardSetPassword(newPassword: string, currentPassword?: string): Promise<void> {
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('Your sign-in has ended. Sign in again.')
  await adopt(await post({ action: 'set_password', new_password: newPassword, current_password: currentPassword }, data.session.access_token))
}

const NOTICE_KEY = 'payslip-hr:signin-notice'

/** A message for the sign-in screen after the app signed the user out. */
export function setSignInNotice(message: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, message)
  } catch {
    // storage blocked: the sign-in screen just shows no notice
  }
}

export function peekSignInNotice(): string {
  try {
    return sessionStorage.getItem(NOTICE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Shown once: cleared after the sign-in screen read it. */
export function clearSignInNotice(): void {
  try {
    sessionStorage.removeItem(NOTICE_KEY)
  } catch {
    // storage blocked
  }
}
