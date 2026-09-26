// @vitest-environment node
// End-to-end shared-analysis scenarios: real coordinators, IndexedDB resume store,
// gzip/hash encoding, and derived pipeline against an in-memory server that enforces
// the same lease, sequence, and subscription rules as the FastAPI service.
import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'

import type { EngineLine, ManifestGame } from './analysis/classify'
import { canonicalJson, sha256Hex } from './analysis/hash'
import { deriveArtifacts } from './analysis/pipeline'
import { ENGINE_BUILD } from './engine/protocol'
import { HostedApiError } from './hosted/api'
import { CheckpointStore } from './hosted/checkpointStore'
import { AnalysisCoordinator, type CoordinatorDeps, type EngineHandle } from './hosted/coordinator'
import { gunzip, gzip } from './hosted/encoding'
import type { JobView } from './hosted/types'

const LEASE_MS = 60_000
const game = (id: string, moves: string[]): ManifestGame => ({
  game_id: id, user_color: 'white', game_date: `2026-01-0${id.slice(-1)}`, white: 'me', black: 'you',
  white_rating: 1500, black_rating: 1500, result: '*', time_control: '180', rated: true, eco: 'C20',
  opening: null, source_url: null, moves, clocks: moves.map(() => null),
})
const GAMES = [
  game('g1', ['e2e4', 'e7e5', 'g1f3']),
  game('g2', ['d2d4', 'd7d5', 'c2c4']),
  game('g3', ['c2c4', 'e7e5', 'b1c3']),
]

class FakeServer {
  now = 0
  status: JobView['status'] = 'queued'
  completed = 0
  sequence = 0
  lease: { token: string; account: string; device: string; expiresAt: number } | null = null
  subscribers = new Map<string, { state: 'active' | 'stopped' | 'completed'; canCompute: boolean }>()
  checkpoints: { sequence: number; hash: string; first: number; last: number; url: string }[] = []
  artifacts = new Map<string, string>()
  objects = new Map<string, Uint8Array>()
  grants = new Map<string, { hash: string; kind: string }>()
  tokens = 0
  finalizeAttempts: { account: string; accepted: boolean }[] = []
  manifestHash = ''
  configHash = ''
  engineHash = ''
  config = { depth: 1, min_group_size: 1, brilliant_multipv: 2, engine: ENGINE_BUILD }

  async init() {
    const body = new TextEncoder().encode(JSON.stringify({ games: GAMES }))
    this.manifestHash = await sha256Hex(body)
    this.objects.set('signed://manifest', await gzip(body))
    this.configHash = await sha256Hex(canonicalJson(this.config))
    this.engineHash = await sha256Hex(canonicalJson(ENGINE_BUILD))
  }

  private leaseValid() {
    return this.lease !== null && this.lease.expiresAt > this.now
  }

  private view(account: string): JobView {
    const subscriber = this.subscribers.get(account)
    return {
      id: 'job', player_id: 'player', status: this.status, completed_units: this.completed,
      total_units: GAMES.length, checkpoint_sequence: this.sequence, analysis_config_hash: this.configHash,
      manifest_hash: this.manifestHash, compute_source: 'community_computed', worker_active: this.leaseValid(),
      subscription_state: subscriber?.state ?? null, can_compute: subscriber?.canCompute ?? false,
      updated_at: new Date(this.now).toISOString(), finished_at: null,
    }
  }

  join(account: string, canCompute: boolean): JobView {
    const existing = this.subscribers.get(account)
    this.subscribers.set(account, { state: this.status === 'succeeded' ? 'completed' : 'active', canCompute })
    if (!existing && this.status === 'paused') this.status = 'queued'
    return this.view(account)
  }

  private verify(account: string, device: string, token: string) {
    const subscriber = this.subscribers.get(account)
    if (!this.lease || !this.leaseValid() || this.lease.token !== token || this.lease.account !== account
      || this.lease.device !== device || subscriber?.state !== 'active') {
      throw new HostedApiError('This browser no longer holds the analysis lease', 409, 'lease_lost')
    }
  }

  api(account: string): CoordinatorDeps['api'] {
    const server = this
    return {
      job: async () => server.view(account),
      claim: async (_job: string, device: string) => {
        const subscriber = server.subscribers.get(account)
        if (!subscriber || subscriber.state !== 'active' || !subscriber.canCompute) {
          throw new HostedApiError('This browser is observing only', 403, 'observer_only')
        }
        if (server.status === 'succeeded') throw new HostedApiError('Finished', 409, 'lease_unavailable')
        const same = server.lease?.account === account && server.lease.device === device
        if (server.leaseValid() && !same) throw new HostedApiError('Another browser is analyzing', 409, 'lease_unavailable')
        server.lease = { token: `token-${++server.tokens}`, account, device, expiresAt: server.now + LEASE_MS }
        server.status = 'running'
        return {
          lease_token: server.lease.token, expires_at: '', lease_seconds: 60, renew_interval_seconds: 20,
          completed_units: server.completed, total_units: GAMES.length, checkpoint_sequence: server.sequence,
        }
      },
      renew: async (_job, body) => {
        server.verify(account, body.device_id, body.lease_token)
        server.lease!.expiresAt = server.now + LEASE_MS
        return {
          lease_token: body.lease_token, expires_at: '', lease_seconds: 60, renew_interval_seconds: 20,
          completed_units: server.completed, total_units: GAMES.length, checkpoint_sequence: server.sequence,
        }
      },
      release: async (_job, body) => {
        if (server.lease?.token === body.lease_token && server.lease.account === account) {
          server.lease = null
          server.status = 'queued'
        }
      },
      stop: async () => {
        server.subscribers.set(account, { ...server.subscribers.get(account)!, state: 'stopped' })
        if (server.lease?.account === account) server.lease = null
        const anyone = [...server.subscribers.values()].some((item) => item.state === 'active')
        if (!anyone && server.status !== 'succeeded') server.status = 'paused'
        return server.view(account)
      },
      setCompute: async (_job, canCompute) => {
        server.subscribers.set(account, { ...server.subscribers.get(account)!, canCompute })
        if (!canCompute && server.lease?.account === account) server.lease = null
        return server.view(account)
      },
      manifest: async () => ({
        manifest_hash: server.manifestHash, download_url: 'signed://manifest', expires_in: 300,
        total_units: GAMES.length, analysis_config_hash: server.configHash,
        engine_build_hash: server.engineHash, analysis_config: server.config,
      }),
      upload: async (_job, body) => {
        server.verify(account, body.device_id, body.lease_token)
        const key = body.kind === 'checkpoint' ? `cp-${body.sequence}-${body.content_hash}` : `art-${body.artifact_type}-${body.content_hash}`
        if (body.kind === 'checkpoint' && body.sequence !== server.sequence + 1) {
          const done = server.checkpoints.find((item) => item.sequence === body.sequence && item.hash === body.content_hash)
          if (!done) throw new HostedApiError('Unexpected checkpoint sequence', 409, 'sequence_conflict')
          return { storage_key: key, upload_url: null, content_type: 'application/gzip', expires_at: '', already_finalized: true }
        }
        server.grants.set(key, { hash: body.content_hash, kind: body.kind })
        return { storage_key: key, upload_url: `signed://${key}`, content_type: 'application/gzip', expires_at: '', already_finalized: false }
      },
      finalizeCheckpoint: async (_job, body) => {
        try {
          server.verify(account, body.device_id, body.lease_token)
        } catch (error) {
          server.finalizeAttempts.push({ account, accepted: false })
          throw error
        }
        const url = `signed://cp-${body.sequence}-${body.content_hash}`
        const bytes = server.objects.get(url)
        if (!bytes || await sha256Hex(bytes) !== body.content_hash) throw new HostedApiError('Upload missing', 422, 'checkpoint_rejected')
        const payload = JSON.parse(new TextDecoder().decode(await gunzip(bytes, 1 << 25)))
        if (body.sequence !== server.sequence + 1 || payload.first_unit !== server.completed) {
          throw new HostedApiError('Unexpected checkpoint sequence', 409, 'sequence_conflict')
        }
        server.checkpoints.push({ sequence: body.sequence, hash: body.content_hash, first: payload.first_unit, last: payload.last_unit, url })
        server.sequence = body.sequence
        server.completed = payload.last_unit + 1
        server.finalizeAttempts.push({ account, accepted: true })
        return { sequence: body.sequence, content_hash: body.content_hash, byte_size: bytes.byteLength, result_count: 0, first_unit: payload.first_unit, last_unit: payload.last_unit }
      },
      checkpoints: async () => ({
        checkpoints: server.checkpoints.map((item) => ({
          sequence: item.sequence, content_hash: item.hash, byte_size: 0, result_count: 0,
          first_unit: item.first, last_unit: item.last, download_url: item.url,
        })),
        dependency_hash: await sha256Hex(canonicalJson({
          analysis_config_hash: server.configHash, manifest_hash: server.manifestHash,
          checkpoints: server.checkpoints.map((item) => item.hash),
        })),
      }),
      finalizeArtifact: async (_job, body) => {
        server.verify(account, body.device_id, body.lease_token)
        server.artifacts.set(body.artifact_type, body.content_hash)
        return {
          artifact_type: body.artifact_type as 'report', dependency_hash: '', schema_version: '1',
          content_hash: body.content_hash, byte_size: 0, compute_source: 'community_computed',
          analysis_config_hash: server.configHash, created_at: '',
        }
      },
      complete: async (_job, body) => {
        server.verify(account, body.device_id, body.lease_token)
        if (server.completed !== GAMES.length || server.artifacts.size !== 3) {
          throw new HostedApiError('Incomplete', 409, 'incomplete_job')
        }
        server.status = 'succeeded'
        server.lease = null
        for (const [key, value] of server.subscribers) {
          if (value.state === 'active') server.subscribers.set(key, { ...value, state: 'completed' })
        }
        return server.view(account)
      },
    }
  }
}

/** An engine that can block after `pauseAfter` searches, to hold a worker mid-analysis. */
function gatedEngine(pauseAfter = Number.POSITIVE_INFINITY) {
  let release: () => void = () => undefined
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const searches = { count: 0 }
  const engine: EngineHandle = {
    async search(): Promise<EngineLine[]> {
      if (searches.count >= pauseAfter) await blocked
      searches.count += 1
      return [{ score: { cp: 15 }, pv: [] }]
    },
    terminate: vi.fn(),
  }
  return { engine, searches, resume: () => release() }
}

const stores: CheckpointStore[] = []
const coordinators: AnalysisCoordinator[] = []
let serial = 0

async function browser(server: FakeServer, account: string, device: string, options: {
  computeAllowed?: boolean
  engine?: ReturnType<typeof gatedEngine>
} = {}) {
  const store = await CheckpointStore.open({ name: `e2e-${account}-${++serial}`, maxBytes: 64 * 1024 * 1024 })
  stores.push(store)
  const engine = options.engine ?? gatedEngine()
  const coordinator = new AnalysisCoordinator({
    api: server.api(account),
    store,
    createEngine: () => engine.engine,
    derive: deriveArtifacts,
    deviceId: device,
    computeAllowed: options.computeAllowed ?? true,
    limits: { maxUploadBytes: 8 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024 },
    checkpointGames: 1,
    pollIntervalMs: 20,
    locks: null,
    environment: { online: () => true, visible: () => true, listen: () => () => undefined },
    now: () => server.now,
    putSigned: async (url, bytes) => { server.objects.set(url, bytes) },
    downloadSigned: async (url) => {
      const bytes = server.objects.get(url)
      if (!bytes) throw new HostedApiError('missing', 404, 'object_missing')
      return bytes
    },
  })
  coordinators.push(coordinator)
  return { coordinator, engine, store }
}

afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.dispose())
  stores.splice(0).forEach((store) => store.close())
})

async function sharedJob() {
  const server = new FakeServer()
  await server.init()
  return server
}

test('two accounts share one job and one lease; the other browser observes', async () => {
  const server = await sharedJob()
  server.join('alice', true)
  server.join('bob', true)
  const alice = await browser(server, 'alice', 'device-aaaaaaaaaaaaaaaa')
  const bob = await browser(server, 'bob', 'device-bbbbbbbbbbbbbbbb')

  await alice.coordinator.start('job')
  await vi.waitFor(() => expect(server.lease?.account).toBe('alice'))
  await bob.coordinator.start('job')

  await vi.waitFor(() => expect(bob.coordinator.current.message).toBe('Another browser is analyzing'))
  expect(bob.coordinator.current.state).toBe('observing')
  await vi.waitFor(() => expect(server.status).toBe('succeeded'), { timeout: 5000 })
  expect(server.checkpoints.map((item) => item.sequence)).toEqual([1, 2, 3])
  expect(bob.engine.searches.count).toBe(0)
  await vi.waitFor(() => expect(bob.coordinator.current.state).toBe('succeeded'))
})

test('a closed worker tab is taken over from the acknowledged checkpoint and its stale finalize is rejected', async () => {
  const server = await sharedJob()
  server.join('alice', true)
  server.join('bob', true)
  // Game one is two user moves, two searches each; then Alice's engine stalls.
  const aliceEngine = gatedEngine(4)
  const alice = await browser(server, 'alice', 'device-aaaaaaaaaaaaaaaa', { engine: aliceEngine })
  await alice.coordinator.start('job')
  await vi.waitFor(() => expect(server.completed).toBe(1))
  const staleToken = server.lease!.token

  // The tab disappears without releasing (crash / closed laptop): only expiry frees it.
  server.now += LEASE_MS + 1
  const bob = await browser(server, 'bob', 'device-bbbbbbbbbbbbbbbb')
  await bob.coordinator.start('job')

  await vi.waitFor(() => expect(server.lease?.account).toBe('bob'))
  await vi.waitFor(() => expect(bob.coordinator.current.resumed).toBe(true))
  await expect(server.api('alice').finalizeCheckpoint('job', {
    device_id: 'device-aaaaaaaaaaaaaaaa', lease_token: staleToken, sequence: 2, content_hash: 'x'.repeat(64),
  })).rejects.toMatchObject({ code: 'lease_lost' })
  await vi.waitFor(() => expect(server.status).toBe('succeeded'), { timeout: 5000 })
  expect(server.checkpoints.map((item) => item.first)).toEqual([0, 1, 2])
  expect(server.finalizeAttempts.filter((item) => item.account === 'alice' && item.accepted)).toHaveLength(1)
  expect(bob.engine.searches.count).toBeLessThan(aliceEngine.searches.count + 4 * 2)
})

test('one subscriber stopping does not block the other', async () => {
  const server = await sharedJob()
  server.join('alice', true)
  server.join('bob', true)
  // Game one is two user moves, two searches each; then Alice's engine stalls.
  const aliceEngine = gatedEngine(4)
  const alice = await browser(server, 'alice', 'device-aaaaaaaaaaaaaaaa', { engine: aliceEngine })
  const bob = await browser(server, 'bob', 'device-bbbbbbbbbbbbbbbb')
  await alice.coordinator.start('job')
  await vi.waitFor(() => expect(server.completed).toBe(1))
  await bob.coordinator.start('job')

  await alice.coordinator.stopObserving()

  expect(alice.coordinator.current.state).toBe('stopped')
  expect(alice.engine.engine.terminate).toHaveBeenCalled()
  await vi.waitFor(() => expect(server.status).toBe('succeeded'), { timeout: 5000 })
  expect(server.finalizeAttempts.filter((item) => item.accepted).map((item) => item.account))
    .toEqual(['alice', 'bob', 'bob'])
  expect(server.subscribers.get('alice')?.state).toBe('stopped')
})

test('completed results are reused without any computation', async () => {
  const server = await sharedJob()
  server.join('alice', true)
  const alice = await browser(server, 'alice', 'device-aaaaaaaaaaaaaaaa')
  await alice.coordinator.start('job')
  await vi.waitFor(() => expect(server.status).toBe('succeeded'), { timeout: 5000 })

  server.join('carol', true)
  const carol = await browser(server, 'carol', 'device-cccccccccccccccc')
  await carol.coordinator.start('job')

  expect(carol.coordinator.current.state).toBe('succeeded')
  expect(carol.engine.searches.count).toBe(0)
})

test('an observer-only browser never claims, even when no one is computing', async () => {
  const server = await sharedJob()
  server.join('dave', false)
  const dave = await browser(server, 'dave', 'device-dddddddddddddddd', { computeAllowed: false })

  await dave.coordinator.start('job')
  await new Promise((resolve) => setTimeout(resolve, 80))

  expect(server.lease).toBeNull()
  expect(dave.coordinator.current.state).toBe('observing')
  expect(dave.engine.searches.count).toBe(0)
})
