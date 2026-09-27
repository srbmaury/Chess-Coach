import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'

import { createHostedClient, getHostedConfig } from './config'

export type Unsubscribe = () => void

async function client(): Promise<SupabaseClient> {
  return createHostedClient(await getHostedConfig())
}

export const MIN_PASSWORD_LENGTH = 8

export type AuthEvent = AuthChangeEvent | undefined
export type SignUpResult = 'signed_in' | 'confirm_email'

// Supabase error codes mapped to messages that are safe to show. Anything else
// becomes the caller's generic fallback so provider details never reach the page.
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password',
  email_not_confirmed: 'Confirm your email first. Check your inbox for the link.',
  weak_password: `Choose a stronger password (at least ${MIN_PASSWORD_LENGTH} characters)`,
  same_password: 'Choose a password different from your current one',
  over_email_send_rate_limit: 'Too many emails were sent recently. Try again in a few minutes.',
  over_request_rate_limit: 'Too many attempts. Try again in a few minutes.',
}

class AuthError extends Error {}

function authError(error: unknown, fallback: string): Error {
  if (error instanceof AuthError) return error
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return new Error(MESSAGES[code] ?? fallback)
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!normalized) throw new AuthError('Enter an email address')
  return normalized
}

function checkPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Use at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  return password
}

// Links in auth emails return to this site. The origin must be listed under
// Supabase Auth -> URL Configuration -> Redirect URLs.
const returnUrl = () => window.location.origin

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  try {
    const { data, error } = await (await client()).auth.signUp({
      email: normalizeEmail(email),
      password: checkPassword(password),
      options: { emailRedirectTo: returnUrl() },
    })
    if (error) throw error
    // With email confirmation on (the default) no session exists until the link is
    // opened. An already-registered address gets the same answer, so sign-up never
    // reveals which emails have accounts.
    return data.session ? 'signed_in' : 'confirm_email'
  } catch (error) {
    throw authError(error, 'Unable to create your account')
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  try {
    if (!password) throw new AuthError('Enter your password')
    const { error } = await (await client()).auth.signInWithPassword({ email: normalizeEmail(email), password })
    if (error) throw error
  } catch (error) {
    throw authError(error, 'Unable to sign in')
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  try {
    const { error } = await (await client()).auth.resetPasswordForEmail(normalizeEmail(email), {
      redirectTo: returnUrl(),
    })
    if (error) throw error
  } catch (error) {
    throw authError(error, 'Unable to send a reset link')
  }
}

/** Set a new password for the signed-in user (e.g. after opening a reset link). */
export async function updatePassword(password: string): Promise<void> {
  try {
    const { error } = await (await client()).auth.updateUser({ password: checkPassword(password) })
    if (error) throw error
  } catch (error) {
    throw authError(error, 'Unable to update your password')
  }
}

export function observeSession(callback: (session: Session | null, event?: AuthEvent) => void): Unsubscribe {
  let stopped = false
  let unsubscribe: Unsubscribe | undefined
  void (async () => {
    try {
      const auth = (await client()).auth
      if (stopped) return
      let latestEvent: string | undefined
      let latestSession: Session | null = null
      const result = auth.onAuthStateChange((event, session) => {
        latestEvent = event
        latestSession = session
        if (!stopped) callback(session, event)
      })
      unsubscribe = () => result.data.subscription.unsubscribe()
      if (stopped) {
        unsubscribe()
        return
      }
      const { data, error } = await auth.getSession()
      if (error) throw error
      if (
        !stopped &&
        (!latestEvent || (latestEvent === 'INITIAL_SESSION' && !latestSession && data.session))
      ) {
        callback(data.session)
      }
    } catch {
      if (!stopped) callback(null)
    }
  })()
  return () => {
    stopped = true
    unsubscribe?.()
  }
}

export async function logout(): Promise<void> {
  try {
    const { error } = await (await client()).auth.signOut()
    if (error) throw error
  } catch {
    throw new Error('Unable to sign out')
  }
}

export async function authorizedFetch(
  session: Session | null,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!session) throw new Error('Please sign in to continue')
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  } catch {
    throw new Error('Authorized request must use this site')
  }
  if (url.origin !== window.location.origin) {
    throw new Error('Authorized request must use this site')
  }
  let accessToken: string | undefined
  try {
    const { data, error } = await (await client()).auth.getSession()
    if (error) throw error
    accessToken = data.session?.access_token
  } catch {
    throw new Error('Please sign in to continue')
  }
  if (!accessToken) throw new Error('Please sign in to continue')
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(input, { ...init, headers })
}
