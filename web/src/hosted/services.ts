// Everything the hosted UI needs from the outside world, behind one seam so the
// component can be tested without Supabase, IndexedDB, or a real engine.
import type { Session } from '@supabase/supabase-js'

import { EngineWorkerClient } from '../engine/workerClient'
import { createStockfishWorker } from '../engine/stockfishWorker'
import { downloadSigned, HostedApi } from './api'
import { authorizedFetch, logout, observeSession, requestMagicLink, type Unsubscribe } from './auth'
import { CheckpointStore } from './checkpointStore'
import { createHostedClient, type HostedBrowserConfig } from './config'
import { AnalysisCoordinator, browserEnvironment, type CoordinatorSnapshot } from './coordinator'
import { deriveInWorker } from './derive'
import { detectCapabilities, deviceId, type Capabilities } from './device'
import { gunzipJson } from './encoding'
import { subscribeToJob, type ProgressFeed } from './realtime'

export type HostedConfig = Extract<HostedBrowserConfig, { hosted: true }>

export interface CoordinatorLike {
  subscribe(listener: (snapshot: CoordinatorSnapshot) => void): () => void
  start(jobId: string): Promise<void>
  nudge(): void
  setComputeAllowed(allowed: boolean): Promise<void>
  stopObserving(): Promise<void>
  dispose(): void
}

export type HostedServices = {
  observeSession(callback: (session: Session | null) => void): Unsubscribe
  requestMagicLink(email: string): Promise<void>
  logout(): Promise<void>
  capabilities(): Promise<Capabilities>
  createApi(session: Session): HostedApi
  createCoordinator(api: HostedApi, computeAllowed: boolean): Promise<CoordinatorLike>
  subscribeProgress(session: Session, jobId: string, onProgress: () => void, onConnection: (connected: boolean) => void): Promise<ProgressFeed>
  downloadArtifact<T>(url: string): Promise<T>
}

export function createDefaultServices(config: HostedConfig): HostedServices {
  const limits = { maxUploadBytes: config.max_upload_bytes, maxDecompressedBytes: config.max_decompressed_bytes }
  let storePromise: Promise<CheckpointStore> | undefined
  return {
    observeSession,
    requestMagicLink,
    logout,
    capabilities: () => detectCapabilities(),
    createApi: (session) => new HostedApi((input, init) => authorizedFetch(session, input, init)),
    async createCoordinator(api, computeAllowed) {
      storePromise ??= CheckpointStore.open({ maxBytes: config.max_browser_cache_bytes })
      return new AnalysisCoordinator({
        api,
        store: await storePromise,
        createEngine: (depth) => new EngineWorkerClient(createStockfishWorker, { depth }),
        derive: deriveInWorker,
        deviceId: deviceId(),
        computeAllowed,
        limits,
        environment: browserEnvironment(),
      })
    },
    async subscribeProgress(session, jobId, onProgress, onConnection) {
      return subscribeToJob(createHostedClient(config), jobId, session.access_token, onProgress, onConnection)
    },
    async downloadArtifact<T>(url: string) {
      return gunzipJson<T>(await downloadSigned(url, limits.maxUploadBytes), limits.maxDecompressedBytes)
    },
  }
}
