// Hosted mode: sign in, then run the classic app with an authenticated transport.
// Engine-backed practice routes are answered in the browser; everything else goes to
// the server with the current session token.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'

import { setApiTransport } from '../apiTransport'
import type { HostedEnvironment } from '../hostedContext'
import { createPracticeRoutes, hostedTransport } from '../practice/localRoutes'
import type { EngineHandle } from './coordinator'
import { createDefaultServices, type HostedConfig, type HostedServices } from './services'
import { NewPassword, SignIn } from './SignIn'
import './hosted.css'

/** Search depth for practice replies, hints, and explanations (the local default). */
export const PRACTICE_DEPTH = 14

type Props = {
  config: HostedConfig
  services?: HostedServices
  children: (hosted: HostedEnvironment) => ReactNode
}

export default function HostedShell({ config, services: injected, children }: Props) {
  const services = useMemo(() => injected ?? createDefaultServices(config), [injected, config])
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  // Set while arriving from a password-reset email: signed in, but must choose a new password.
  const [recovering, setRecovering] = useState(false)
  const [transportReady, setTransportReady] = useState(false)

  useEffect(() => services.observeSession((next, event) => {
    setSession(next)
    if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    if (!next) setRecovering(false)
  }), [services])

  const userId = session?.user?.id ?? (session ? 'signed-in' : null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  useLayoutEffect(() => {
    if (!userId) return
    let engine: EngineHandle | null = null
    // authorizedFetch reads the latest token itself, so a refreshed session needs no rebuild.
    const server = (input: string, init?: RequestInit) => services.authorizedFetch(sessionRef.current ?? null, input, init)
    const local = createPracticeRoutes(server, () => (engine ??= services.createPracticeEngine(PRACTICE_DEPTH)), PRACTICE_DEPTH)
    setApiTransport(hostedTransport(server, local))
    setTransportReady(true)
    return () => {
      setApiTransport(null)
      setTransportReady(false)
      engine?.terminate()
    }
  }, [services, userId])

  const signOut = () => { void services.logout() }

  if (session === undefined) return <p className="muted hosted-loading">Loading…</p>
  if (session === null || recovering) {
    return <div className="hosted-shell">
      <header className="hosted-header">
        <div className="brand"><b>♞</b><div><strong>Chess ML Coach</strong><small>Personal training lab</small></div></div>
        {session && <button className="ghost" onClick={signOut}>Sign out</button>}
      </header>
      <main className="hosted-main">
        {session === null
          ? <SignIn services={services} />
          : <NewPassword services={services} onDone={() => setRecovering(false)} />}
      </main>
    </div>
  }
  if (!transportReady) return <p className="muted hosted-loading">Loading…</p>
  return <>{children({ session, services, config, email: session.user?.email ?? null, signOut })}</>
}
