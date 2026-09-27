// What the classic pages need to know when running in hosted mode.
import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'

import type { HostedPipeline } from './hosted/pipelineDriver'
import type { HostedConfig, HostedServices } from './hosted/services'

export type HostedEnvironment = {
  session: Session
  services: HostedServices
  config: HostedConfig
  email: string | null
  signOut: () => void
  /** Runs the Pipeline page's stages for the whole session. */
  pipeline: HostedPipeline
}

export const HostedContext = createContext<HostedEnvironment | null>(null)

export const useHosted = () => useContext(HostedContext)
