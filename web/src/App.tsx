import { lazy, Suspense, useEffect, useState } from 'react'

import CommunityControls from './CommunityControls'
import CoachApp from './LegacyApp'
import { getHostedConfig, type HostedBrowserConfig } from './hosted/config'

const HostedAnalysis = lazy(() => import('./hosted/HostedAnalysis'))

type Mode = { kind: 'loading' } | { kind: 'local' } | { kind: 'hosted'; config: Extract<HostedBrowserConfig, { hosted: true }> }

function LocalApp() {
  const [profileRevision, setProfileRevision] = useState(0)
  const [activeProfile, setActiveProfile] = useState<string | null | undefined>(undefined)

  return <>
    <CommunityControls
      onProfileChanged={() => setProfileRevision((value) => value + 1)}
      onActiveProfileChanged={setActiveProfile}
    />
    {activeProfile ? <CoachApp key={`${activeProfile}-${profileRevision}`} /> : null}
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
  if (mode.kind === 'local') return <LocalApp />
  return <Suspense fallback={null}><HostedAnalysis config={mode.config} /></Suspense>
}
