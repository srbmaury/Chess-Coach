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
    job: vi.fn(async () => job({ analysis_config_hash: analysisConfigHash, manifest_hash: manifestHash, worker_active: options.active ?? false })),
    claim: vi.fn(async () => options.grant ?? lease()), renew: vi.fn(async () => lease()),
    release: vi.fn(async () => undefined), stop: vi.fn(async () => job({ subscription_state: 'stopped' })),
    setCompute: vi.fn(async () => job()), manifest: vi.fn(async () => manifest),
    upload: vi.fn(), finalizeCheckpoint: vi.fn(), checkpoints: vi.fn(), finalizeArtifact: vi.fn(), complete: vi.fn(),
  }
  const putSigned = vi.fn(async () => undefined)
  const coordinator = new AnalysisCoordinator({
    api: api as unknown as CoordinatorDeps['api'], store, createEngine: () => engine,
    derive: vi.fn(), deviceId: 'device', computeAllowed: options.computeAllowed ?? true,
    limits: { maxUploadBytes: 8 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024 },
    downloadSigned: vi.fn(async () => manifestBytes),
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
  return { api, coordinator, engine, store, name, putSigned, fire, setNow: (value: number) => { now = value }, setOnline: (value: boolean) => { online = value }, setVisible: (value: boolean) => { visible = value } }
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

test('refresh resumes a sealed unacknowledged batch at the server sequence', async () => {
  const { api, coordinator, store, putSigned, engine } = await fixture()
  await store.saveBatch({ jobId: 'job', sequence: 1, firstUnit: 0, lastUnit: 0, contentHash: 'saved-hash', bytes: new Uint8Array([1, 2]) })
  api.upload.mockResolvedValue({ storage_key: 'checkpoint', upload_url: 'signed://checkpoint', content_type: 'application/gzip', expires_at: '', already_finalized: false })
  api.finalizeCheckpoint.mockResolvedValue({ sequence: 1, content_hash: 'saved-hash', byte_size: 2, result_count: 1, first_unit: 0, last_unit: 0 })
  api.checkpoints.mockImplementation(() => deferred<never>().promise)
  await coordinator.start('job')
  await vi.waitFor(() => expect(api.finalizeCheckpoint).toHaveBeenCalledOnce())
  expect(api.upload).toHaveBeenCalledWith('job', expect.objectContaining({ sequence: 1, content_hash: 'saved-hash' }))
  expect(putSigned.mock.calls[0][0]).toBe('signed://checkpoint')
  expect(Array.from(putSigned.mock.calls[0][1])).toEqual([1, 2])
  expect(putSigned.mock.calls[0][2]).toBe('application/gzip')
  expect(engine.search).not.toHaveBeenCalled()
  expect(await store.pendingBatch('job', 1, 0)).toBeNull()
  coordinator.dispose()
})
