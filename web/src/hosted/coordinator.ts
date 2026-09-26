// Browser coordinator for shared analysis: observe a job, claim and renew its worker
// lease, analyze games in the engine worker, checkpoint them to Storage, and derive
// and publish results.
//
// Every asynchronous step belongs to a "generation". Losing the lease, stopping,
// going offline, or disposing starts a new generation and terminates the engine, so
// a late completion from the old run can never upload or change state.
import { analyzeGame, type MoveEngine, type ManifestGame } from '../analysis/classify'
import { canonicalJson, sha256Hex } from '../analysis/hash'
import { ARTIFACT_TYPES, type DeriveInput, type DerivedArtifacts } from '../analysis/pipeline'
import { ENGINE_BUILD } from '../engine/protocol'
import { downloadSigned, HostedApiError, putSigned, type HostedApi } from './api'
import { isAnalysisRow, StorageQuotaError, type BatchRecord, type CheckpointStore } from './checkpointStore'
import { gunzip, gunzipJson, gzipJson } from './encoding'
import type { JobView, LeaseResponse, ManifestResponse } from './types'

export type CoordinatorState =
  | 'idle' | 'observing' | 'claiming' | 'running' | 'uploading' | 'paused'
  | 'lease_lost' | 'succeeded' | 'failed' | 'stopped'

export type CoordinatorSnapshot = {
  state: CoordinatorState
  job: JobView | null
  /** Games analyzed on this device since the last acknowledged checkpoint. */
  localUnits: number
  /** This run resumed from another browser's (or an earlier session's) checkpoint. */
  resumed: boolean
  message: string | null
}

export interface EngineHandle extends MoveEngine {
  terminate(): void
}

type LockManagerLike = {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>
}

export type CoordinatorEnvironment = {
  online(): boolean
  visible(): boolean
  listen(type: 'online' | 'offline' | 'visibilitychange' | 'pagehide', listener: () => void): () => void
}

export type CoordinatorDeps = {
  api: Pick<HostedApi,
    'job' | 'claim' | 'renew' | 'release' | 'stop' | 'setCompute' | 'manifest' | 'upload'
    | 'finalizeCheckpoint' | 'checkpoints' | 'finalizeArtifact' | 'complete'>
  store: CheckpointStore
  createEngine: (depth: number) => EngineHandle
  derive: (input: DeriveInput) => Promise<DerivedArtifacts>
  deviceId: string
  /** Capability and user opt-in; observers never claim. */
  computeAllowed: boolean
  limits: { maxUploadBytes: number; maxDecompressedBytes: number }
  checkpointGames?: number
  pollIntervalMs?: number
  locks?: LockManagerLike | null
  environment?: CoordinatorEnvironment
  putSigned?: typeof putSigned
  downloadSigned?: typeof downloadSigned
  now?: () => number
}

type Lease = { token: string; renewMs: number; leaseMs: number; lastRenewedAt: number }

class StaleRun extends Error {}

const MANIFEST_MAX_BYTES = 64 * 1024 * 1024

export function browserEnvironment(): CoordinatorEnvironment {
  return {
    online: () => globalThis.navigator?.onLine ?? true,
    visible: () => globalThis.document?.visibilityState !== 'hidden',
    listen(type, listener) {
      const target: EventTarget = type === 'visibilitychange' ? document : window
      target.addEventListener(type, listener)
      return () => target.removeEventListener(type, listener)
    },
  }
}

export class AnalysisCoordinator {
  private snapshot: CoordinatorSnapshot = { state: 'idle', job: null, localUnits: 0, resumed: false, message: null }
  private readonly listeners = new Set<(snapshot: CoordinatorSnapshot) => void>()
  private generation = 0
  private jobId: string | null = null
  private lease: Lease | null = null
  private engine: EngineHandle | null = null
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private renewing: Promise<void> | null = null
  private claiming = false
  private releaseLock: (() => void) | null = null
  private unlisten: (() => void)[] = []
  private computeAllowed: boolean
  private readonly now: () => number
  private readonly environment: CoordinatorEnvironment
  private readonly locks: LockManagerLike | null

  constructor(private readonly deps: CoordinatorDeps) {
    this.computeAllowed = deps.computeAllowed
    this.now = deps.now ?? (() => Date.now())
    this.environment = deps.environment ?? browserEnvironment()
    this.locks = deps.locks === undefined ? (globalThis.navigator?.locks as LockManagerLike | undefined) ?? null : deps.locks
  }

  get current(): CoordinatorSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: CoordinatorSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  private emit(patch: Partial<CoordinatorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener(this.snapshot))
  }

  private check(generation: number): void {
    if (generation !== this.generation) throw new StaleRun()
  }

  private leaseBody() {
    if (!this.lease) throw new HostedApiError('This browser no longer holds the analysis lease', 409, 'lease_lost')
    return { device_id: this.deps.deviceId, lease_token: this.lease.token }
  }

  // Lifecycle -----------------------------------------------------------------------------

  async start(jobId: string): Promise<void> {
    if (this.jobId === jobId && (this.lease || this.claiming)) return
    if (this.jobId && this.jobId !== jobId) {
      const previousJob = this.jobId
      const previousLease = this.lease
      this.abandonRun('idle', null)
      if (previousLease) void this.deps.api.release(previousJob, { device_id: this.deps.deviceId, lease_token: previousLease.token }).catch(() => undefined)
    }
    this.jobId = jobId
    const generation = ++this.generation
    const environment = this.environment
    if (environment && !this.unlisten.length) {
      this.unlisten = [
        environment.listen('offline', () => this.goOffline()),
        environment.listen('online', () => void this.refresh(this.generation)),
        environment.listen('visibilitychange', () => this.onVisibility()),
        environment.listen('pagehide', () => this.dispose()),
      ]
    }
    await this.refresh(generation)
  }

  /** Re-read server state now (e.g. after a Realtime event). */
  nudge(): void {
    if (!this.lease && this.jobId && !['stopped', 'succeeded'].includes(this.snapshot.state)) {
      void this.refresh(this.generation)
    }
  }

  async setComputeAllowed(allowed: boolean): Promise<void> {
    this.computeAllowed = allowed
    const jobId = this.jobId
    if (!jobId) return
    const lease = this.lease
    if (!allowed) {
      this.abandonRun('observing', null)
      if (lease) void this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: lease.token }).catch(() => undefined)
    }
    const generation = this.generation
    const job = await this.deps.api.setCompute(jobId, allowed)
    if (generation !== this.generation || jobId !== this.jobId || this.computeAllowed !== allowed) return
    this.emit({ job })
    void this.refresh(generation)
  }

  async stopObserving(): Promise<void> {
    const jobId = this.jobId
    const lease = this.lease
    const generation = this.abandonRun('stopped', null)
    this.clearPoll()
    if (jobId) {
      if (lease) await this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: lease.token }).catch(() => undefined)
      const job = await this.deps.api.stop(jobId)
      if (generation !== this.generation || jobId !== this.jobId) return
      this.emit({ job, state: 'stopped' })
    }
  }

  dispose(): void {
    const jobId = this.jobId
    const lease = this.lease
    this.abandonRun(this.snapshot.state, this.snapshot.message)
    this.clearPoll()
    this.unlisten.forEach((remove) => remove())
    this.unlisten = []
    if (jobId && lease) {
      void this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: lease.token }, true).catch(() => undefined)
    }
    this.listeners.clear()
  }

  /** End the current run: new generation, engine stopped, timers and lock released. */
  private abandonRun(state: CoordinatorState, message: string | null): number {
    const generation = ++this.generation
    this.engine?.terminate()
    this.engine = null
    this.lease = null
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = null
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    this.releaseLock?.()
    this.releaseLock = null
    this.claiming = false
    this.emit({ state, message, localUnits: 0 })
    return generation
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private schedulePoll(generation: number): void {
    this.clearPoll()
    this.pollTimer = setTimeout(() => {
      if (generation === this.generation) void this.refresh(generation)
    }, this.deps.pollIntervalMs ?? 5000)
  }

  // Observation --------------------------------------------------------------------------

  private async refresh(generation: number): Promise<void> {
    const jobId = this.jobId
    if (!jobId || this.lease || generation !== this.generation) return
    let job: JobView
    try {
      job = await this.deps.api.job(jobId)
    } catch (error) {
      if (generation !== this.generation) return
      this.emit({ message: error instanceof HostedApiError && error.status === 0 ? 'Waiting for the network…' : 'Could not refresh progress' })
      this.schedulePoll(generation)
      return
    }
    if (generation !== this.generation || this.lease) return
    this.emit({ job })
    if (job.status === 'succeeded') {
      this.clearPoll()
      this.emit({ state: 'succeeded', message: null })
      await this.deps.store.clearJob(jobId).catch(() => undefined)
      return
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      this.emit({ state: 'failed', message: 'This analysis was stopped by an administrator' })
      return
    }
    if (job.subscription_state !== 'active') {
      this.emit({ state: 'stopped' })
      return
    }
    const online = this.environment.online()
    if (!online) {
      this.emit({ state: 'paused', message: 'Offline — progress resumes when you reconnect' })
    } else if (this.computeAllowed && job.can_compute && !job.worker_active) {
      void this.tryClaim(generation)
    } else if (!this.claiming) {
      this.emit({
        state: 'observing',
        message: job.worker_active ? 'Another browser is analyzing' : this.computeAllowed ? null : 'Following progress',
      })
    }
    this.schedulePoll(generation)
  }

  private acquireLock(jobId: string): Promise<boolean> {
    const locks = this.locks
    if (!locks) return Promise.resolve(true)
    return new Promise((resolve) => {
      void locks.request(`chess-coach-analysis-${jobId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        return new Promise<void>((release) => { this.releaseLock = release })
      }).catch(() => resolve(false))
    })
  }

  private async tryClaim(generation: number): Promise<void> {
    const jobId = this.jobId
    if (!jobId || this.claiming || this.lease) return
    this.claiming = true
    this.emit({ state: 'claiming', message: null })
    try {
      const locked = await this.acquireLock(jobId)
      if (generation !== this.generation) {
        this.releaseLock?.()
        this.releaseLock = null
        return
      }
      if (!locked) {
        this.emit({ state: 'observing', message: 'Another tab on this device is analyzing' })
        return
      }
      let grant: LeaseResponse
      try {
        grant = await this.deps.api.claim(jobId, this.deps.deviceId)
      } catch (error) {
        this.releaseLock?.()
        this.releaseLock = null
        if (generation !== this.generation) return
        const busy = error instanceof HostedApiError && error.code === 'lease_unavailable'
        this.emit({ state: 'observing', message: busy ? 'Another browser is analyzing' : (error as Error).message })
        return
      }
      if (generation !== this.generation || !this.computeAllowed) {
        await this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: grant.lease_token }).catch(() => undefined)
        this.releaseLock?.()
        this.releaseLock = null
        return
      }
      this.clearPoll()
      this.lease = {
        token: grant.lease_token,
        renewMs: grant.renew_interval_seconds * 1000,
        leaseMs: grant.lease_seconds * 1000,
        lastRenewedAt: this.now(),
      }
      this.scheduleRenew(generation)
      this.scheduleLeaseDeadline(generation)
      void this.run(generation, jobId, grant)
    } finally {
      this.claiming = false
    }
  }

  // Lease renewal ------------------------------------------------------------------------

  private scheduleRenew(generation: number, delay?: number): void {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = setTimeout(() => void this.renewNow(generation), delay ?? this.lease?.renewMs ?? 20_000)
  }

  private scheduleLeaseDeadline(generation: number): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    const lease = this.lease
    if (!lease) return
    this.leaseTimer = setTimeout(() => {
      if (generation !== this.generation || !this.lease) return
      if (this.now() - this.lease.lastRenewedAt >= this.lease.leaseMs) {
        this.loseLease('The analysis lease expired')
      } else {
        this.scheduleLeaseDeadline(generation)
      }
    }, lease.leaseMs)
  }

  private renewNow(generation: number): Promise<void> {
    // Never overlap renewals; a slow one finishes before the next is scheduled.
    if (this.renewing) return this.renewing
    this.renewing = (async () => {
      const jobId = this.jobId
      if (!jobId || !this.lease || generation !== this.generation) return
      try {
        const grant = await this.deps.api.renew(jobId, this.leaseBody())
        if (generation !== this.generation || !this.lease) return
        this.lease.lastRenewedAt = this.now()
        this.scheduleRenew(generation)
        this.scheduleLeaseDeadline(generation)
        this.emit({ job: this.snapshot.job && { ...this.snapshot.job, worker_active: true, completed_units: grant.completed_units } })
      } catch (error) {
        if (generation !== this.generation || !this.lease) return
        const lost = error instanceof HostedApiError && error.status !== 0 && error.status < 500 && error.status !== 429
        if (lost || this.now() - this.lease.lastRenewedAt >= this.lease.leaseMs) {
          this.loseLease('Another browser took over this analysis')
        } else {
          this.scheduleRenew(generation, Math.min(5000, this.lease.renewMs))
        }
      }
    })().finally(() => { this.renewing = null })
    return this.renewing
  }

  private onVisibility(): void {
    const environment = this.environment
    if (!environment?.visible() || !this.lease) return
    if (this.now() - this.lease.lastRenewedAt >= this.lease.leaseMs) {
      this.loseLease('The analysis lease expired')
      return
    }
    // Background tabs throttle timers; renew at once if a renewal is overdue.
    if (this.now() - this.lease.lastRenewedAt >= this.lease.renewMs) void this.renewNow(this.generation)
  }

  private loseLease(message: string): void {
    const generation = this.abandonRun('lease_lost', message)
    this.schedulePoll(generation)
  }

  private goOffline(): void {
    if (['stopped', 'succeeded'].includes(this.snapshot.state)) return
    const jobId = this.jobId
    const lease = this.lease
    this.abandonRun('paused', 'Offline — progress resumes when you reconnect')
    if (jobId && lease) void this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: lease.token }).catch(() => undefined)
    this.clearPoll()
  }

  // Computation ----------------------------------------------------------------------------

  private async run(generation: number, jobId: string, grant: LeaseResponse): Promise<void> {
    try {
      const manifest = await this.deps.api.manifest(jobId)
      this.check(generation)
      await this.verifyConfig(manifest)
      const games = await this.loadGames(jobId, manifest)
      this.check(generation)
      const config = manifest.analysis_config
      const engine = this.deps.createEngine(config.depth)
      this.engine = engine
      let completed = grant.completed_units
      let sequence = grant.checkpoint_sequence
      this.emit({
        state: 'running',
        resumed: completed > 0,
        message: completed > 0 ? 'Resuming from checkpoint' : null,
        job: this.snapshot.job && { ...this.snapshot.job, completed_units: completed, checkpoint_sequence: sequence, worker_active: true },
      })
      await this.deps.store.discardBefore(jobId, sequence, completed)
      this.check(generation)

      const pending = await this.deps.store.pendingBatch(jobId, sequence + 1, completed)
      this.check(generation)
      if (pending) {
        if (await this.validPendingBatch(pending, manifest, games)) {
          this.check(generation)
          await this.commitBatch(generation, jobId, pending)
          this.check(generation)
          completed = pending.lastUnit + 1
          sequence = pending.sequence
        } else {
          this.check(generation)
          await this.deps.store.discardBatch(jobId, pending.sequence)
          this.check(generation)
        }
      }
      const batchGames = this.deps.checkpointGames ?? 10
      while (completed < games.length) {
        this.check(generation)
        const last = Math.min(games.length, completed + batchGames) - 1
        const analyzed: { game_id: string; rows: unknown[] }[] = []
        for (let unit = completed; unit <= last; unit += 1) {
          const game = games[unit]
          let rows = await this.deps.store.gameRows(jobId, unit, game.game_id)
          this.check(generation)
          if (!rows) {
            rows = await analyzeGame(game, engine, { multipv: config.brilliant_multipv })
            this.check(generation)
            await this.deps.store.saveGameRows(jobId, unit, game.game_id, rows)
            this.check(generation)
          }
          analyzed.push({ game_id: game.game_id, rows })
          this.emit({ localUnits: unit - completed + 1, state: 'running', message: null })
        }
        const bytes = await gzipJson({
          schema_version: 1,
          job_id: jobId,
          sequence: sequence + 1,
          analysis_config_hash: manifest.analysis_config_hash,
          engine_build_hash: manifest.engine_build_hash,
          first_unit: completed,
          last_unit: last,
          games: analyzed,
        })
        if (bytes.byteLength > this.deps.limits.maxUploadBytes) throw new Error('A checkpoint exceeded the upload size limit')
        const batch = { jobId, sequence: sequence + 1, firstUnit: completed, lastUnit: last, contentHash: await sha256Hex(bytes), bytes }
        this.check(generation)
        await this.deps.store.saveBatch(batch)
        this.check(generation)
        await this.commitBatch(generation, jobId, { version: 1, ...batch })
        this.check(generation)
        completed = last + 1
        sequence += 1
      }
      this.check(generation)
      await this.deriveAndComplete(generation, jobId, manifest, games)
    } catch (error) {
      await this.handleRunError(generation, jobId, error)
    }
  }

  private async verifyConfig(manifest: ManifestResponse): Promise<void> {
    const hash = await sha256Hex(canonicalJson(manifest.analysis_config))
    const engine = canonicalJson(manifest.analysis_config.engine)
    if (hash !== manifest.analysis_config_hash || engine !== canonicalJson(ENGINE_BUILD)
      || manifest.engine_build_hash !== await sha256Hex(canonicalJson(ENGINE_BUILD))) {
      throw new Error('This page is out of date for the current analysis settings; reload to continue')
    }
  }

  private async loadGames(jobId: string, manifest: ManifestResponse): Promise<ManifestGame[]> {
    const decode = async (compressed: Uint8Array): Promise<ManifestGame[]> => {
      const body = await gunzip(compressed, MANIFEST_MAX_BYTES)
      if (await sha256Hex(body) !== manifest.manifest_hash) throw new Error('The game list failed its integrity check')
      const document = JSON.parse(new TextDecoder().decode(body)) as unknown
      if (!document || typeof document !== 'object' || !('games' in document)
        || !Array.isArray(document.games) || document.games.length !== manifest.total_units) {
        throw new Error('The game list does not match this analysis')
      }
      return document.games as ManifestGame[]
    }
    const cached = await this.deps.store.manifest(jobId, manifest.manifest_hash)
    if (cached) {
      try { return await decode(cached) } catch {
        await this.deps.store.discardManifest(jobId, manifest.manifest_hash)
      }
    }
    const compressed = await (this.deps.downloadSigned ?? downloadSigned)(manifest.download_url, MANIFEST_MAX_BYTES)
    const games = await decode(compressed)
    await this.deps.store.cacheManifest(jobId, manifest.manifest_hash, compressed)
    return games
  }

  private async validPendingBatch(batch: BatchRecord, manifest: ManifestResponse, games: ManifestGame[]): Promise<boolean> {
    try {
      const payload = await gunzipJson<unknown>(batch.bytes, this.deps.limits.maxDecompressedBytes)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
      const item = payload as Record<string, unknown>
      if (item.schema_version !== 1 || item.job_id !== batch.jobId || item.sequence !== batch.sequence
        || item.analysis_config_hash !== manifest.analysis_config_hash || item.engine_build_hash !== manifest.engine_build_hash
        || item.first_unit !== batch.firstUnit || item.last_unit !== batch.lastUnit
        || !Array.isArray(item.games) || item.games.length !== batch.lastUnit - batch.firstUnit + 1) return false
      return item.games.every((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
        const game = entry as Record<string, unknown>
        return game.game_id === games[batch.firstUnit + index]?.game_id
          && Array.isArray(game.rows) && game.rows.every(isAnalysisRow)
      })
    } catch {
      return false
    }
  }

  private async commitBatch(generation: number, jobId: string, batch: BatchRecord): Promise<void> {
    this.check(generation)
    this.emit({ state: 'uploading' })
    const upload = await this.deps.api.upload(jobId, {
      ...this.leaseBody(), kind: 'checkpoint', sequence: batch.sequence, byte_size: batch.bytes.byteLength,
      content_hash: batch.contentHash,
    })
    this.check(generation)
    if (!upload.already_finalized && upload.upload_url) {
      await (this.deps.putSigned ?? putSigned)(upload.upload_url, batch.bytes, upload.content_type)
      this.check(generation)
    }
    await this.deps.api.finalizeCheckpoint(jobId, { ...this.leaseBody(), sequence: batch.sequence, content_hash: batch.contentHash })
    this.check(generation)
    await this.deps.store.acknowledge(jobId, batch.sequence, batch.lastUnit)
    this.check(generation)
    this.emit({
      state: 'running',
      localUnits: 0,
      job: this.snapshot.job && {
        ...this.snapshot.job, completed_units: batch.lastUnit + 1, checkpoint_sequence: batch.sequence,
      },
    })
  }

  private async deriveAndComplete(generation: number, jobId: string, manifest: ManifestResponse, games: ManifestGame[]): Promise<void> {
    this.check(generation)
    this.emit({ state: 'running', message: 'Building puzzles and your report' })
    const listing = await this.deps.api.checkpoints(jobId)
    this.check(generation)
    const analysis = new Map<string, never[]>()
    for (const checkpoint of listing.checkpoints) {
      const bytes = await (this.deps.downloadSigned ?? downloadSigned)(checkpoint.download_url!, this.deps.limits.maxUploadBytes)
      if (await sha256Hex(bytes) !== checkpoint.content_hash) throw new Error('A checkpoint failed its integrity check')
      const payload = await gunzipJson<{ games: { game_id: string; rows: never[] }[] }>(bytes, this.deps.limits.maxDecompressedBytes)
      payload.games.forEach((game) => analysis.set(game.game_id, game.rows))
      this.check(generation)
    }
    const dependencyHash = await sha256Hex(canonicalJson({
      analysis_config_hash: manifest.analysis_config_hash,
      manifest_hash: manifest.manifest_hash,
      checkpoints: listing.checkpoints.map((checkpoint) => checkpoint.content_hash),
    }))
    if (dependencyHash !== listing.dependency_hash) throw new Error('Checkpoints changed while building results')
    const artifacts = await this.deps.derive({
      games,
      analysis,
      minGroupSize: manifest.analysis_config.min_group_size,
      dependencyHash,
      analysisConfigHash: manifest.analysis_config_hash,
    })
    this.check(generation)
    this.emit({ state: 'uploading' })
    for (const type of ARTIFACT_TYPES) {
      const bytes = await gzipJson(artifacts[type])
      const contentHash = await sha256Hex(bytes)
      const upload = await this.deps.api.upload(jobId, {
        ...this.leaseBody(), kind: 'artifact', artifact_type: type, byte_size: bytes.byteLength, content_hash: contentHash,
      })
      this.check(generation)
      if (!upload.already_finalized && upload.upload_url) {
        await (this.deps.putSigned ?? putSigned)(upload.upload_url, bytes, upload.content_type)
        this.check(generation)
      }
      await this.deps.api.finalizeArtifact(jobId, { ...this.leaseBody(), artifact_type: type, content_hash: contentHash })
      this.check(generation)
    }
    const job = await this.deps.api.complete(jobId, this.leaseBody())
    this.check(generation)
    this.abandonRun('succeeded', null)
    this.emit({ job })
    await this.deps.store.clearJob(jobId).catch(() => undefined)
  }

  private async handleRunError(generation: number, jobId: string, error: unknown): Promise<void> {
    if (error instanceof StaleRun || generation !== this.generation) return
    if (error instanceof HostedApiError) {
      if (error.code === 'lease_lost' || error.status === 403 || error.status === 404) {
        this.loseLease('Another browser took over this analysis')
        return
      }
      if (error.status === 0) {
        // Transient network trouble: step back and re-claim once reachable again.
        const next = this.abandonRun('paused', 'Connection problem — retrying shortly')
        this.schedulePoll(next)
        return
      }
    }
    const lease = this.lease
    const message = error instanceof StorageQuotaError
      ? error.message
      : error instanceof Error && error.name === 'EngineError'
        ? 'The analysis engine stopped unexpectedly. Try again, or observe instead.'
        : error instanceof Error ? error.message : 'Analysis failed'
    this.abandonRun('failed', message)
    if (lease) {
      // Hand the job back so another browser can continue from the last checkpoint.
      await this.deps.api.release(jobId, { device_id: this.deps.deviceId, lease_token: lease.token }).catch(() => undefined)
    }
  }
}
