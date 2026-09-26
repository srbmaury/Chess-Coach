import type { Session, SupabaseClient } from '@supabase/supabase-js'

import { createHostedClient, getHostedConfig } from './config'

export type Unsubscribe = () => void

async function client(): Promise<SupabaseClient> {
  return createHostedClient(await getHostedConfig())
}

export async function requestMagicLink(email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) throw new Error('Enter an email address')
  try {
    const { error } = await (await client()).auth.signInWithOtp({ email: normalizedEmail })
    if (error) throw error
  } catch {
    throw new Error('Unable to send sign-in link')
  }
}

export function observeSession(callback: (session: Session | null) => void): Unsubscribe {
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
        if (!stopped) callback(session)
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
