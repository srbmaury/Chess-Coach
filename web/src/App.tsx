import { lazy, Suspense, useEffect, useState } from 'react'

import CommunityControls from './CommunityControls'
import CoachApp from './LegacyApp'
import { getHostedConfig, type HostedBrowserConfig } from './hosted/config'
import type { HostedEnvironment } from './hostedContext'

const HostedShell = lazy(() => import('./hosted/HostedShell'))

type Mode = { kind: 'loading' } | { kind: 'local' } | { kind: 'hosted'; config: Extract<HostedBrowserConfig, { hosted: true }> }

/** The classic app: player bar plus pages. Hosted mode adds sign-in and a server-backed transport. */
function ClassicApp({ hosted = null }: { hosted?: HostedEnvironment | null }) {
  const [profileRevision, setProfileRevision] = useState(0)
  const [activeProfile, setActiveProfile] = useState<string | null | undefined>(undefined)

  return <>
    <CommunityControls
      hosted={hosted}
      onProfileChanged={() => setProfileRevision((value) => value + 1)}
      onActiveProfileChanged={setActiveProfile}
    />
    {activeProfile ? <CoachApp key={`${activeProfile}-${profileRevision}`} hosted={hosted} /> : null}
  </>
}

export default function App() {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    // Local installs (and older servers without the endpoint) keep the local shell.
    getHostedConfig()
      .then((config) => { if (active) setMode(config.hosted ? { kind: 'hosted', config } : { kind: 'local' }) })
      .catch(() => { if (active) setMode({ kind: 'local' }) })
    return () => { active = false }
  }, [])

  if (mode.kind === 'loading') return null
  if (mode.kind === 'local') return <ClassicApp />
  return <Suspense fallback={null}>
    <HostedShell config={mode.config}>{(hosted) => <ClassicApp hosted={hosted} />}</HostedShell>
  </Suspense>
}
