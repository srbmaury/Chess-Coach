import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { deleteDB, openDB } from 'idb'

vi.mock('./encoding', () => ({
  gunzip: async (bytes: Uint8Array) => bytes,
  gunzipJson: async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)),
  gzipJson: async (value: unknown) => new TextEncoder().encode(JSON.stringify(value)),
}))

import { canonicalJson, sha256Hex } from '../analysis/hash'
import type { EngineLine } from '../analysis/classify'
import { ENGINE_BUILD } from '../engine/protocol'
import { HostedApiError } from './api'
import { CheckpointStore } from './checkpointStore'
import { AnalysisCoordinator, type CoordinatorDeps, type EngineHandle } from './coordinator'
import type { JobView, LeaseResponse, ManifestResponse } from './types'

let serial = 0
const openStores: CheckpointStore[] = []
const turn = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const job = (changes: Partial<JobView> = {}): JobView => ({
  id: 'job', player_id: 'player', status: 'queued', completed_units: 0, total_units: 1,
  checkpoint_sequence: 0, analysis_config_hash: '', manifest_hash: '', compute_source: 'browser',
  worker_active: false, subscription_state: 'active', can_compute: true,
  updated_at: '2026-09-26T00:00:00Z', finished_at: null, ...changes,
})
const lease = (): LeaseResponse => ({
  lease_token: 'secret-lease-token', expires_at: '2026-09-26T00:01:00Z', lease_seconds: 60,
  renew_interval_seconds: 20, completed_units: 0, total_units: 1, checkpoint_sequence: 0,
})

async function fixture(options: { computeAllowed?: boolean; active?: boolean; search?: Promise<EngineLine[]>; grant?: LeaseResponse } = {}) {
  const config = { depth: 1, min_group_size: 1, brilliant_multipv: 2, engine: ENGINE_BUILD }
  const analysisConfigHash = await sha256Hex(canonicalJson(config))
  const game = {
    game_id: 'g1', user_color: 'white', game_date: null, white: 'p', black: 'q', white_rating: null,
    black_rating: null, result: null, time_control: null, rated: null, eco: null, opening: null,
    source_url: null, moves: ['e2e4'], clocks: [null],
  }
  const body = new TextEncoder().encode(JSON.stringify({ games: [game] }))
  const manifestHash = await sha256Hex(body)
  const manifestBytes = body
  const manifest: ManifestResponse = {
    manifest_hash: manifestHash, download_url: 'signed://manifest', expires_in: 60,
    total_units: 1, analysis_config_hash: analysisConfigHash,
    engine_build_hash: await sha256Hex(canonicalJson(ENGINE_BUILD)), analysis_config: config,
  }
  const name = `coordinator-test-${++serial}`
  const store = await CheckpointStore.open({ name, maxBytes: 256 * 1024 * 1024 })
  openStores.push(store)
  const listeners = new Map<string, Set<() => void>>()
  let online = true
  let visible = true
  let now = 0
  const fire = (type: string) => listeners.get(type)?.forEach((listener) => listener())
  const search = options.search ?? deferred<EngineLine[]>().promise
  const engine: EngineHandle = { search: vi.fn(() => search), terminate: vi.fn() }
  const api = {
    job: vi.fn(async (jobId: string) => job({ id: jobId, analysis_config_hash: analysisConfigHash, manifest_hash: manifestHash, worker_active: options.active ?? false })),
    claim: vi.fn(async () => options.grant ?? lease()), renew: vi.fn(async () => lease()),
    release: vi.fn(async () => undefined), stop: vi.fn(async () => job({ subscription_state: 'stopped' })),
    setCompute: vi.fn(async () => job()), manifest: vi.fn(async () => manifest),
    upload: vi.fn(), finalizeCheckpoint: vi.fn(), checkpoints: vi.fn(), finalizeArtifact: vi.fn(), complete: vi.fn(),
  }
  const putSigned = vi.fn(async () => undefined)
  const downloadSigned = vi.fn(async () => manifestBytes)
  const coordinator = new AnalysisCoordinator({
    api: api as unknown as CoordinatorDeps['api'], store, createEngine: () => engine,
    derive: vi.fn(), deviceId: 'device', computeAllowed: options.computeAllowed ?? true,
    limits: { maxUploadBytes: 8 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024 },
    downloadSigned,
    putSigned,
    now: () => now,
    environment: {
      online: () => online, visible: () => visible,
      listen(type, listener) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
        return () => set.delete(listener)
      },
    },
  })
  return { api, coordinator, engine, store, name, manifest, manifestBytes, putSigned, downloadSigned, fire, setNow: (value: number) => { now = value }, setOnline: (value: boolean) => { online = value }, setVisible: (value: boolean) => { visible = value } }
}

async function batchFor(manifest: ManifestResponse) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schema_version: 1, job_id: 'job', sequence: 1,
    analysis_config_hash: manifest.analysis_config_hash,
    engine_build_hash: manifest.engine_build_hash,
    first_unit: 0, last_unit: 0, games: [{ game_id: 'g1', rows: [] }],
  }))
  return { jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: await sha256Hex(bytes), bytes }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const store of openStores) store.close()
  openStores.length = 0
  for (let index = 1; index <= serial; index += 1) await deleteDB(`coordinator-test-${index}`)
  serial = 0
})

test('observer-only browser follows progress without claiming a lease', async () => {
  const { api, coordinator } = await fixture({ computeAllowed: false })
  await coordinator.start('job')
  expect(coordinator.current.state).toBe('observing')
  expect(api.claim).not.toHaveBeenCalled()
  coordinator.dispose()
})

test('claims and renews at 20 seconds without overlapping a slow renewal', async () => {
  const { api, coordinator, fire, setNow } = await fixture()
  const pending = deferred<LeaseResponse>()
  api.renew.mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  vi.useFakeTimers()
  setNow(20_000)
  fire('visibilitychange')
  await turn()
  expect(api.renew).toHaveBeenCalledTimes(1)
  setNow(40_000)
  fire('visibilitychange')
  expect(api.renew).toHaveBeenCalledTimes(1)
  pending.resolve(lease())
  await turn()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(api.renew).toHaveBeenCalledTimes(2)
  coordinator.dispose()
})

test('lease loss immediately terminates the engine and ignores a late search result', async () => {
  const pending = deferred<EngineLine[]>()
  const { api, coordinator, engine, fire, setNow } = await fixture({ search: pending.promise })
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  api.renew.mockRejectedValueOnce(new HostedApiError('lease lost', 409, 'lease_lost'))
  setNow(20_000)
  fire('visibilitychange')
  await turn()
  expect(engine.terminate).toHaveBeenCalledOnce()
  expect(coordinator.current.state).toBe('lease_lost')
  pending.resolve([])
  await turn()
  expect(api.upload).not.toHaveBeenCalled()
  coordinator.dispose()
})

test('a tab returning after lease expiry terminates its worker before renewing', async () => {
  const { api, coordinator, engine, fire, setNow } = await fixture()
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  setNow(60_000)
  fire('visibilitychange')
  expect(engine.terminate).toHaveBeenCalledOnce()
  expect(coordinator.current.state).toBe('lease_lost')
  expect(api.renew).not.toHaveBeenCalled()
  coordinator.dispose()
})

test('stop observing terminates the worker and releases the lease', async () => {
  const { api, coordinator, engine } = await fixture()
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  await coordinator.stopObserving()
  expect(coordinator.current.state).toBe('stopped')
  expect(engine.terminate).toHaveBeenCalledOnce()
  expect(api.release).toHaveBeenCalledWith('job', { device_id: 'device', lease_token: 'secret-lease-token' })
  coordinator.dispose()
})

test('a claim completed after stopping is released without starting a worker', async () => {
  const { api, coordinator, engine } = await fixture()
  const pending = deferred<LeaseResponse>()
  api.claim.mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.claim).toHaveBeenCalledOnce())
  await coordinator.stopObserving()
  pending.resolve(lease())
  await turn()
  expect(coordinator.current.state).toBe('stopped')
  expect(engine.search).not.toHaveBeenCalled()
  expect(api.release).toHaveBeenCalledWith('job', { device_id: 'device', lease_token: 'secret-lease-token' })
  coordinator.dispose()
})

test('compute opt-out invalidates and releases a claim that resolves later', async () => {
  const { api, coordinator, engine } = await fixture()
  const pending = deferred<LeaseResponse>()
  api.claim.mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.claim).toHaveBeenCalledOnce())
  await coordinator.setComputeAllowed(false)
  pending.resolve(lease())
  await turn()
  expect(coordinator.current.state).toBe('observing')
  expect(engine.search).not.toHaveBeenCalled()
  expect(api.release).toHaveBeenCalledWith('job', { device_id: 'device', lease_token: 'secret-lease-token' })
  coordinator.dispose()
})

test('a delayed compute response cannot replace a newer job', async () => {
  const { api, coordinator } = await fixture({ computeAllowed: false })
  const pending = deferred<JobView>()
  api.setCompute.mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  const oldRequest = coordinator.setComputeAllowed(false)
  await coordinator.start('new-job')
  const seen: string[] = []
  const unsubscribe = coordinator.subscribe((snapshot) => { if (snapshot.job) seen.push(snapshot.job.id) })
  pending.resolve(job({ id: 'job', subscription_state: 'stopped' }))
  await oldRequest
  expect(coordinator.current.job?.id).toBe('new-job')
  expect(coordinator.current.state).toBe('observing')
  expect(seen).not.toContain('job')
  unsubscribe()
  coordinator.dispose()
})

test('a delayed stop response cannot overwrite a newer job', async () => {
  const { api, coordinator } = await fixture({ computeAllowed: false })
  const pending = deferred<JobView>()
  api.stop.mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  const oldStop = coordinator.stopObserving()
  await coordinator.start('new-job')
  pending.resolve(job({ id: 'job', subscription_state: 'stopped' }))
  await oldStop
  expect(coordinator.current.job?.id).toBe('new-job')
  expect(coordinator.current.state).toBe('observing')
  coordinator.dispose()
})

test('restarting the same job keeps its live lease and renewal', async () => {
  const { api, coordinator, engine, fire, setNow } = await fixture()
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  await coordinator.start('job')
  expect(coordinator.current.state).toBe('running')
  expect(engine.terminate).not.toHaveBeenCalled()
  setNow(20_000)
  fire('visibilitychange')
  await turn()
  expect(api.renew).toHaveBeenCalledOnce()
  coordinator.dispose()
})

test('navigator locks prevent a second tab with the same device ID from claiming', async () => {
  let held = false
  const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void> | void) => {
    if (held) return callback(null)
    held = true
    try { await callback({}) } finally { held = false }
  })
  vi.stubGlobal('navigator', { locks: { request } })
  const first = await fixture()
  const second = await fixture()
  await first.coordinator.start('job')
  await vi.waitFor(() => expect(first.coordinator.current.state).toBe('running'))
  await second.coordinator.start('job')
  await vi.waitFor(() => expect(second.coordinator.current.state).toBe('observing'))
  expect(second.api.claim).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(2)
  first.coordinator.dispose()
  second.coordinator.dispose()
})

test('IndexedDB contains analysis data without persisting the lease token', async () => {
  const { coordinator, name } = await fixture()
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  const db = await openDB(name)
  const records = [await db.getAll('games'), await db.getAll('batches'), await db.getAll('manifests')]
  db.close()
  expect(JSON.stringify(records)).not.toContain('secret-lease-token')
  coordinator.dispose()
})

test('offline pause terminates the worker and page disposal best-effort releases the lease', async () => {
  const { api, coordinator, engine, fire, setOnline } = await fixture()
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  setOnline(false)
  fire('offline')
  expect(coordinator.current.state).toBe('paused')
  expect(engine.terminate).toHaveBeenCalledOnce()
  expect(api.release).toHaveBeenCalledOnce()
  setOnline(true)
  fire('online')
  await turn()
  expect(api.claim).toHaveBeenCalledTimes(2)
  fire('pagehide')
  expect(api.release).toHaveBeenCalledTimes(2)
})

test('an expired worker lease permits takeover when the job is no longer active', async () => {
  const { api, coordinator } = await fixture({ active: false })
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  expect(api.claim).toHaveBeenCalledOnce()
  expect(coordinator.current.state).toBe('running')
  coordinator.dispose()
})

test('uploads and finalizes a checkpoint, then evicts its acknowledged local rows', async () => {
  const search = Promise.resolve([{ score: { cp: 12 }, pv: ['e2e4'] }])
  const { api, coordinator, store, putSigned } = await fixture({ search })
  api.upload.mockResolvedValue({ storage_key: 'checkpoint', upload_url: 'signed://checkpoint', content_type: 'application/gzip', expires_at: '', already_finalized: false })
  api.finalizeCheckpoint.mockResolvedValue({ sequence: 1, content_hash: '', byte_size: 1, result_count: 1, first_unit: 0, last_unit: 0 })
  api.checkpoints.mockImplementation(() => deferred<never>().promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.finalizeCheckpoint).toHaveBeenCalledOnce())
  expect(putSigned).toHaveBeenCalledOnce()
  expect(coordinator.current.job?.checkpoint_sequence).toBe(1)
  expect(await store.pendingBatch('job', 1, 0)).toBeNull()
  expect(await store.gameRows('job', 0, 'g1')).toBeNull()
  coordinator.dispose()
})

test('a stale checkpoint acknowledgement cannot restore running after stopping', async () => {
  const { api, coordinator, store, manifest } = await fixture()
  await store.saveBatch(await batchFor(manifest))
  api.upload.mockResolvedValue({ storage_key: 'checkpoint', upload_url: null, content_type: 'application/gzip', expires_at: '', already_finalized: true })
  const finalized = deferred<never>()
  api.finalizeCheckpoint.mockImplementationOnce(() => finalized.promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.finalizeCheckpoint).toHaveBeenCalledOnce())
  const acknowledged = deferred<void>()
  const acknowledge = vi.spyOn(store, 'acknowledge').mockImplementationOnce(() => acknowledged.promise)
  finalized.resolve({} as never)
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
  await coordinator.stopObserving()
  acknowledged.resolve()
  await turn()
  expect(coordinator.current.state).toBe('stopped')
  expect(api.checkpoints).not.toHaveBeenCalled()
  coordinator.dispose()
})

test('a pending batch lookup cannot publish uploading after observation stops', async () => {
  const { api, coordinator, store, manifest } = await fixture()
  const pending = deferred<Awaited<ReturnType<CheckpointStore['pendingBatch']>>>()
  const lookup = vi.spyOn(store, 'pendingBatch').mockImplementationOnce(() => pending.promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
  await coordinator.stopObserving()
  pending.resolve({ version: 1, ...await batchFor(manifest) })
  await turn()
  expect(coordinator.current.state).toBe('stopped')
  expect(api.upload).not.toHaveBeenCalled()
  coordinator.dispose()
})

test('a cached batch with a valid hash but invalid payload is discarded and recomputed', async () => {
  const { api, coordinator, store } = await fixture()
  const bytes = new TextEncoder().encode(JSON.stringify({ invalid: true }))
  await store.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: await sha256Hex(bytes), bytes })
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  expect(api.upload).not.toHaveBeenCalled()
  expect(await store.pendingBatch('job', 1, 0)).toBeNull()
  coordinator.dispose()
})

test('a damaged cached manifest is removed and fetched again', async () => {
  const { coordinator, store, manifest, manifestBytes, downloadSigned } = await fixture()
  await store.cacheManifest('job', manifest.manifest_hash, new Uint8Array([1, 2, 3]))
  await coordinator.start('job')
  await vi.waitFor(() => expect(coordinator.current.state).toBe('running'))
  expect(downloadSigned).toHaveBeenCalledOnce()
  expect(Array.from((await store.manifest('job', manifest.manifest_hash)) ?? [])).toEqual(Array.from(manifestBytes))
  coordinator.dispose()
})

test('refresh resumes a sealed unacknowledged batch at the server sequence', async () => {
  const { api, coordinator, store, putSigned, engine, manifest } = await fixture()
  const batch = await batchFor(manifest)
  await store.saveBatch(batch)
  api.upload.mockResolvedValue({ storage_key: 'checkpoint', upload_url: 'signed://checkpoint', content_type: 'application/gzip', expires_at: '', already_finalized: false })
  api.finalizeCheckpoint.mockResolvedValue({ sequence: 1, content_hash: batch.contentHash, byte_size: batch.bytes.byteLength, result_count: 1, first_unit: 0, last_unit: 0 })
  api.checkpoints.mockImplementation(() => deferred<never>().promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.finalizeCheckpoint).toHaveBeenCalledOnce())
  expect(api.upload).toHaveBeenCalledWith('job', expect.objectContaining({ sequence: 1, content_hash: batch.contentHash }))
  expect(putSigned.mock.calls[0][0]).toBe('signed://checkpoint')
  expect(Array.from(putSigned.mock.calls[0][1])).toEqual(Array.from(batch.bytes))
  expect(putSigned.mock.calls[0][2]).toBe('application/gzip')
  expect(engine.search).not.toHaveBeenCalled()
  expect(await store.pendingBatch('job', 1, 0)).toBeNull()
  coordinator.dispose()
})
