// @vitest-environment node
import { expect, test, vi } from 'vitest'

import { canonicalJson, sha256Hex } from '../analysis/hash'
import type { DeriveResult } from '../analysis/pipeline'
import { HostedApiError } from './api'
import type { CoordinatorSnapshot } from './coordinator'
import { gzip, gzipJson } from './encoding'
import { HostedPipeline, pipelineRoutes, type PipelineDeps, type PipelineEvent } from './pipelineDriver'
import type { CoordinatorLike } from './services'
import type { JobView, PipelineStateView, SyncView } from './types'

const idleSync: SyncView = {
  status: 'succeeded', started_at: null, finished_at: null, error: null, current: null, total: null, game_count: 3, synced_at: null,
}

function state(patch: Partial<PipelineStateView> = {}): PipelineStateView {
  return {
    player_id: 'player-1', depth: 12, default_depth: 12, analysis_enabled: true, analysis_config_hash: 'c'.repeat(64),
    sync: idleSync, total_games: 3, analyzed_games: 0, analyzed_moves: 0, dependency_hash: null, job: null, results: {},
    ...patch,
  }
}

function job(patch: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1', player_id: 'player-1', status: 'queued', completed_units: 0, total_units: 3, checkpoint_sequence: 0,
    analysis_config_hash: 'c'.repeat(64), manifest_hash: 'm'.repeat(64), compute_source: 'community_computed',
    worker_active: false, subscription_state: 'active', can_compute: true, updated_at: '', finished_at: null, ...patch,
  }
}

/** A coordinator the test drives by hand. */
function fakeCoordinator() {
  const listeners = new Set<(snapshot: CoordinatorSnapshot) => void>()
  let snapshot: CoordinatorSnapshot = { state: 'idle', job: null, localUnits: 0, resumed: false, message: null }
  const emit = (patch: Partial<CoordinatorSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener(snapshot))
  }
  const coordinator: CoordinatorLike = {
    subscribe(listener) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener) } },
    start: vi.fn(async () => undefined),
    nudge: vi.fn(),
    setComputeAllowed: vi.fn(async () => undefined),
    stopObserving: vi.fn(async () => emit({ state: 'stopped' })),
    dispose: vi.fn(),
  }
  return { coordinator, emit }
}

function setup(patch: Partial<PipelineDeps> = {}) {
  const storage = new Map<string, string>()
  const coordinator = fakeCoordinator()
  const api = {
    profiles: vi.fn(async () => ({ analysis_enabled: true, profiles: [{ username: 'magnus', player_id: 'player-1' }] })),
    pipeline: vi.fn(async () => state()),
    sync: vi.fn(async () => ({ ...idleSync, status: 'running' as const })),
    analyze: vi.fn(async () => job()),
    analysisSet: vi.fn(),
    uploadArtifact: vi.fn(async () => ({ storage_key: 'k', upload_url: 'signed://artifact', content_type: 'application/gzip', expires_at: '', already_finalized: false })),
    finalizeArtifact: vi.fn(async () => ({})),
  }
  const deps = {
    api: api as unknown as PipelineDeps['api'],
    activeUsername: async () => 'magnus',
    createCoordinator: vi.fn(async () => coordinator.coordinator),
    capabilities: async () => ({ supported: true, recommended: true, reason: null }),
    derive: vi.fn(async (): Promise<DeriveResult> => ({ featureRows: 0, artifacts: {} })),
    defaultDepth: 12,
    limits: { maxUploadBytes: 8 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024 },
    storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
    pollMs: 1,
    putSigned: vi.fn(async () => undefined),
    downloadSigned: vi.fn(),
    ...patch,
  }
  const pipeline = new HostedPipeline(deps)
  const events: PipelineEvent[] = []
  pipeline.subscribe((event) => events.push(event))
  return { pipeline, api, deps, events, storage, coordinator }
}

test('sync runs on the server and reports its progress until it finishes', async () => {
  const { pipeline, api, events } = setup()
  api.pipeline
    .mockResolvedValueOnce(state({ sync: { ...idleSync, status: 'running', current: 1, total: 4 } }))
    .mockResolvedValueOnce(state({ sync: { ...idleSync, status: 'running', current: 3, total: 4 } }))
    .mockResolvedValueOnce(state({ total_games: 42 }))

  const started = await pipeline.start('sync')
  expect(started).toMatchObject({ stage: 'sync', status: 'running', username: 'magnus' })
  await vi.waitFor(() => expect(pipeline.status().status).toBe('succeeded'))

  expect(api.sync).toHaveBeenCalledWith('player-1')
  expect(events.map(({ status, current_month }) => [status, current_month])).toEqual([
    ['running', undefined], ['running', 1], ['running', 3], ['succeeded', undefined],
  ])
  expect(pipeline.status().result).toMatchObject({ total_games: 42 })
})

test('one stage at a time, and failures carry the server message', async () => {
  const { pipeline, api } = setup()
  api.pipeline.mockResolvedValue(state({ sync: { ...idleSync, status: 'running', current: 1, total: 4 } }))
  await pipeline.start('sync')
  await expect(pipeline.start('features')).rejects.toMatchObject({ status: 409 })
  api.pipeline.mockResolvedValue(state({ sync: { ...idleSync, status: 'failed', error: 'Chess.com is temporarily unavailable; try again later' } }))
  await vi.waitFor(() => expect(pipeline.status().status).toBe('failed'))
  expect(pipeline.status().error).toBe('Chess.com is temporarily unavailable; try again later')
})

test('analyze runs the coordinator at the chosen depth and remembers it', async () => {
  const { pipeline, api, coordinator, storage, events } = setup()
  api.pipeline.mockResolvedValue(state({ analyzed_games: 3, analyzed_moves: 60 }))
  await pipeline.start('analyze', { depth: 16 })
  await vi.waitFor(() => expect(coordinator.coordinator.start).toHaveBeenCalledWith('job-1'))

  coordinator.emit({ state: 'running', job: job({ completed_units: 1, worker_active: true }), localUnits: 1 })
  expect(events.at(-1)).toMatchObject({ stage: 'analyze', completed_games: 2, total_games: 3, worker: 'this browser' })
  coordinator.emit({ state: 'succeeded' })
  await vi.waitFor(() => expect(pipeline.status().status).toBe('succeeded'))

  expect(api.analyze).toHaveBeenCalledWith('player-1', 16, true)
  expect(pipeline.status().result).toMatchObject({ depth: 16, analyzed_games: 3, analyzed_moves: 60 })
  expect(storage.get('chess-coach-analysis-depth')).toBe('16')
  expect(pipeline.depth).toBe(16)
  expect(coordinator.coordinator.dispose).toHaveBeenCalled()
})

test('stop cancels analysis; only analysis can be stopped', async () => {
  const { pipeline, coordinator } = setup()
  await expect(pipeline.stop()).rejects.toMatchObject({ status: 409 })
  await pipeline.start('analyze')
  await vi.waitFor(() => expect(coordinator.coordinator.start).toHaveBeenCalled())

  expect((await pipeline.stop()).status).toBe('stopping')
  await vi.waitFor(() => expect(pipeline.status().status).toBe('cancelled'))
  expect(coordinator.coordinator.stopObserving).toHaveBeenCalled()
})

test('already analyzed games need no engine', async () => {
  const { pipeline, api, deps } = setup()
  api.analyze.mockResolvedValue(job({ status: 'succeeded', subscription_state: 'completed' }))
  await pipeline.start('analyze')
  await vi.waitFor(() => expect(pipeline.status().status).toBe('succeeded'))
  expect(deps.createCoordinator).not.toHaveBeenCalled()
})

test('a reload picks up a running sync or analysis', async () => {
  const sync = setup()
  sync.api.pipeline
    .mockResolvedValueOnce(state({ sync: { ...idleSync, status: 'running', current: 2, total: 5 } }))
    .mockResolvedValue(state())
  await sync.pipeline.resume()
  expect(sync.pipeline.status()).toMatchObject({ stage: 'sync', status: 'running' })
  await vi.waitFor(() => expect(sync.pipeline.status().status).toBe('succeeded'))
  expect(sync.api.sync).not.toHaveBeenCalled()

  const analysis = setup()
  analysis.api.pipeline.mockResolvedValue(state({ depth: 12, job: job({ status: 'running' }) }))
  await analysis.pipeline.resume()
  expect(analysis.pipeline.status()).toMatchObject({ stage: 'analyze', status: 'running' })
  await vi.waitFor(() => expect(analysis.coordinator.coordinator.start).toHaveBeenCalledWith('job-1'))
  expect(analysis.api.analyze).not.toHaveBeenCalled()
})

async function analysisSet() {
  const games = [{ game_id: 'g1' }, { game_id: 'g2' }, { game_id: 'g3' }]
  const manifestBody = new TextEncoder().encode(JSON.stringify({ games }))
  const checkpoint = await gzipJson({ games: [{ game_id: 'g1', rows: [{ ply: 1 }] }, { game_id: 'g2', rows: [] }] })
  const checkpointHash = await sha256Hex(checkpoint)
  const set = {
    manifest_hash: await sha256Hex(manifestBody), manifest_url: 'signed://manifest', analysis_config_hash: 'c'.repeat(64),
    analysis_config: { depth: 12, min_group_size: 5, brilliant_multipv: 2 }, total_games: 3, analyzed_games: 1, analyzed_moves: 1,
    dependency_hash: '', checkpoints: [{ content_hash: checkpointHash, game_ids: ['g1'], download_url: 'signed://cp' }],
  }
  set.dependency_hash = await sha256Hex(canonicalJson({
    analysis_config_hash: set.analysis_config_hash, manifest_hash: set.manifest_hash, checkpoints: [checkpointHash],
  }))
  const objects: Record<string, Uint8Array> = { 'signed://manifest': await gzip(manifestBody), 'signed://cp': checkpoint }
  return { set, checkpointHash, download: vi.fn(async (url: string) => objects[url]) }
}

test('puzzles build from the analyzed games and publish citing their checkpoints', async () => {
  const { set, checkpointHash, download } = await analysisSet()
  const { pipeline, api, deps } = setup({ downloadSigned: download as never })
  api.analysisSet.mockResolvedValue(set)
  vi.mocked(deps.derive).mockResolvedValue({
    featureRows: 7,
    artifacts: { puzzles: { schema_version: 1, artifact_type: 'puzzles', dependency_hash: set.dependency_hash, analysis_config_hash: set.analysis_config_hash, puzzles: [{} as never, {} as never] } },
  })

  await pipeline.start('puzzles', { depth: 12 })
  await vi.waitFor(() => expect(pipeline.status().status).toBe('succeeded'))

  const [input, only] = vi.mocked(deps.derive).mock.calls[0]
  expect(only).toEqual(['puzzles'])
  // Only the games this checkpoint is credited with.
  expect(input.games.map((game) => game.game_id)).toEqual(['g1'])
  expect([...input.analysis.keys()]).toEqual(['g1'])
  expect(input.minGroupSize).toBe(5)
  expect(api.uploadArtifact).toHaveBeenCalledWith('player-1', expect.objectContaining({ depth: 12, artifact_type: 'puzzles', checkpoint_hashes: [checkpointHash] }))
  expect(deps.putSigned).toHaveBeenCalledOnce()
  expect(api.finalizeArtifact).toHaveBeenCalledWith('player-1', expect.objectContaining({ artifact_type: 'puzzles', checkpoint_hashes: [checkpointHash] }))
  expect(pipeline.status().result).toMatchObject({ eligible_puzzles: 2 })

  // Features reuse the downloaded analysis and publish nothing.
  await pipeline.start('features')
  await vi.waitFor(() => expect(pipeline.status()).toMatchObject({ stage: 'features', status: 'succeeded' }))
  expect(download).toHaveBeenCalledTimes(2)
  expect(api.uploadArtifact).toHaveBeenCalledOnce()
  expect(pipeline.status().result).toMatchObject({ feature_rows: 7 })
})

test('results need analyzed games', async () => {
  const { set } = await analysisSet()
  const { pipeline, api } = setup()
  api.analysisSet.mockResolvedValue({ ...set, analyzed_games: 0, checkpoints: [] })
  await pipeline.start('report')
  await vi.waitFor(() => expect(pipeline.status().status).toBe('failed'))
  expect(pipeline.status().error).toMatch(/run Analyze first/)

  api.analysisSet.mockRejectedValue(new HostedApiError('Run Sync first to fetch your Chess.com games', 409, 'not_synced'))
  await pipeline.start('train')
  await vi.waitFor(() => expect(pipeline.status()).toMatchObject({ stage: 'train', status: 'failed' }))
  expect(pipeline.status().error).toBe('Run Sync first to fetch your Chess.com games')
})

test('routes answer like the local server', async () => {
  const { pipeline } = setup()
  const routes = pipelineRoutes(pipeline)
  expect(await routes('/api/dashboard')).toBeNull()
  expect(await (await routes('/api/pipeline/status'))!.json()).toMatchObject({ status: 'idle' })
  expect((await routes('/api/pipeline/nope', { method: 'POST' }))!.status).toBe(404)
  const bad = await routes('/api/pipeline/analyze', { method: 'POST', body: JSON.stringify({ depth: 99 }) })
  expect(bad!.status).toBe(422)
  expect(await bad!.json()).toEqual({ detail: 'Stockfish depth must be between 1 and 20' })
})
