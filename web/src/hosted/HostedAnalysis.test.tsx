import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { onPieceDrop?: (move: { sourceSquare: string; targetSquare: string }) => boolean } }) => (
    <button aria-label="Play e2e4" onClick={() => options.onPieceDrop?.({ sourceSquare: 'e2', targetSquare: 'e4' })}>board</button>
  ),
}))

import HostedAnalysis from './HostedAnalysis'
import type { CoordinatorSnapshot } from './coordinator'
import type { CoordinatorLike, HostedConfig, HostedServices } from './services'
import type { JobView, ProfileView } from './types'

afterEach(cleanup)

const CONFIG: HostedConfig = {
  hosted: true, supabase_url: 'https://p.supabase.co', supabase_publishable_key: 'sb_publishable_x',
  analysis_enabled: true, engine_version: '19.0.0', config_version: '1', lease_seconds: 60,
  renew_interval_seconds: 20, max_upload_bytes: 1, max_decompressed_bytes: 1, max_browser_cache_bytes: 1,
}
const SESSION = { access_token: 'token', user: { email: 'player@example.test' } }

const job = (changes: Partial<JobView> = {}): JobView => ({
  id: 'job-1', player_id: 'player-1', status: 'running', completed_units: 3, total_units: 10,
  checkpoint_sequence: 1, analysis_config_hash: 'c', manifest_hash: 'm', compute_source: 'community_computed',
  worker_active: true, subscription_state: 'active', can_compute: true, updated_at: '2026-09-26T00:00:00Z',
  finished_at: null, ...changes,
})
const profile = (changes: Partial<ProfileView> = {}): ProfileView => ({
  id: 'profile-1', player_id: 'player-1', username: 'magnuscarlsen', display_username: 'MagnusCarlsen',
  slot_type: 'free', state: 'active', can_compute: true, latest_job: null, has_results: false, ...changes,
})

class FakeCoordinator implements CoordinatorLike {
  listener: ((snapshot: CoordinatorSnapshot) => void) | null = null
  started: string[] = []
  computeCalls: boolean[] = []
  stopped = false
  disposed = false
  subscribe(listener: (snapshot: CoordinatorSnapshot) => void) { this.listener = listener; return () => undefined }
  async start(jobId: string) { this.started.push(jobId) }
  nudge() {}
  async setComputeAllowed(allowed: boolean) { this.computeCalls.push(allowed) }
  async stopObserving() {
    this.stopped = true
    this.emit({ state: 'stopped', job: job({ subscription_state: 'stopped', worker_active: false }) })
  }
  dispose() { this.disposed = true }
  emit(snapshot: Partial<CoordinatorSnapshot>) {
    this.listener?.({ state: 'observing', job: null, localUnits: 0, resumed: false, message: null, ...snapshot })
  }
}

function setup(options: {
  session?: typeof SESSION | null
  profiles?: ProfileView[]
  artifacts?: boolean
  supported?: boolean
  recommended?: boolean
  analysisEnabled?: boolean
} = {}) {
  const coordinator = new FakeCoordinator()
  const api = {
    profiles: vi.fn(async () => ({ analysis_enabled: options.analysisEnabled ?? true, profiles: options.profiles ?? [profile()] })),
    claimProfile: vi.fn(async (username: string) => {
      if (username === 'second') throw new Error('Additional players require an active subscription')
      return { analysis_enabled: true, profiles: [profile({ username, display_username: username })] }
    }),
    results: vi.fn(async () => ({
      player_id: 'player-1',
      artifacts: options.artifacts ? ['report', 'puzzles', 'model_summary'].map((type) => ({
        artifact_type: type, dependency_hash: 'd', schema_version: '1', content_hash: 'h', byte_size: 1,
        compute_source: 'community_computed', analysis_config_hash: 'c', created_at: '2026-09-26T00:00:00Z',
        download_url: `memory://${type}`,
      })) : [],
    })),
    createJob: vi.fn(async (_player: string, canCompute: boolean) => job({ completed_units: 0, worker_active: false, can_compute: canCompute })),
  }
  const documents: Record<string, unknown> = {
    'memory://report': { markdown: '# Chess ML Coach Report\n\n## Your priorities\n- **Opening**: needs work\n' },
    'memory://puzzles': { puzzles: [{
      puzzle_id: 'p1', game_id: 'g', ply: 1, fen_before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      color: 'white', game_label: 'Magnus vs Hikaru', move_label: '1.a3', your_move_san: 'a3', your_move_uci: 'a2a3',
      best_move_san: 'e4', best_move_uci: 'e2e4', cpl: 150, eval_loss_pawns: 1.5, quality: 'mistake', opening: 'x',
      eco: 'C20', game_phase: 'opening', source_url: '', motif: 'positional / calculation', difficulty: 2, quality_reason: '',
    }] },
    'memory://model_summary': { status: 'insufficient_data', reason: 'At least 3 games are required' },
  }
  const services: HostedServices = {
    observeSession: (callback) => { callback(options.session === undefined ? SESSION as never : options.session as never); return () => undefined },
    requestMagicLink: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    capabilities: async () => ({
      supported: options.supported ?? true, recommended: options.recommended ?? true,
      reason: options.supported === false ? 'This browser lacks WebAssembly; it can follow progress but not compute.' : null,
    }),
    createApi: () => api as never,
    createCoordinator: vi.fn(async () => coordinator),
    subscribeProgress: vi.fn(async () => ({ close: () => undefined })),
    downloadArtifact: async <T,>(url: string) => documents[url] as T,
  }
  render(<HostedAnalysis config={CONFIG} services={services} />)
  return { api, services, coordinator }
}

test('signed-out visitors get a magic-link form', async () => {
  const { services } = setup({ session: null })
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'Player@Example.test' } })
  fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))

  expect(await screen.findByText('Check your email for a sign-in link.')).toBeTruthy()
  expect(services.requestMagicLink).toHaveBeenCalledWith('Player@Example.test')
})

test('hosted mode has no Pipeline page and offers sign out', async () => {
  const { services } = setup()
  await screen.findByRole('heading', { name: 'MagnusCarlsen' })
  expect(screen.queryByText('Pipeline')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(services.logout).toHaveBeenCalled()
})

test('paid-slot errors are shown when adding another player', async () => {
  setup()
  await screen.findByRole('heading', { name: 'MagnusCarlsen' })
  fireEvent.change(screen.getByLabelText('Chess.com username'), { target: { value: 'second' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(await screen.findByText('Additional players require an active subscription')).toBeTruthy()
})

test('existing ready results are reused with a community-computed badge', async () => {
  setup({ artifacts: true, profiles: [profile({ has_results: true, latest_job: job({ status: 'succeeded', subscription_state: 'completed' }) })] })

  expect(await screen.findByText('Community computed')).toBeTruthy()
  expect(await screen.findByText('Opening')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Update with new games' })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Puzzles' }))
  fireEvent.click(screen.getByRole('button', { name: 'Play e2e4' }))
  expect(await screen.findByText('Correct — e4')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Mistake model' }))
  expect(screen.getByText(/Not enough data/)).toBeTruthy()
})

test('starting analysis creates a job with the device compute choice and follows it', async () => {
  const { api, coordinator } = setup()
  const analyze = await screen.findByRole('button', { name: 'Analyze my games' }) as HTMLButtonElement
  await waitFor(() => expect(analyze.disabled).toBe(false))
  fireEvent.click(analyze)

  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  expect(api.createJob).toHaveBeenCalledWith('player-1', true)
  coordinator.emit({ state: 'observing', job: job(), message: 'Another browser is analyzing' })
  expect(await screen.findByText('Another browser is analyzing')).toBeTruthy()
  expect(screen.getByText(/3 of 10 games saved/)).toBeTruthy()
})

test('takeover resumes from the checkpoint rather than resetting', async () => {
  const { coordinator } = setup({ profiles: [profile({ latest_job: job() })] })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  coordinator.emit({ state: 'running', resumed: true, localUnits: 2, job: job({ completed_units: 5 }) })

  expect(await screen.findByText('Resumed from the last saved checkpoint.')).toBeTruthy()
  expect(screen.getByText('5 of 10 games saved · 2 more analyzed here')).toBeTruthy()
})

test('opting out of computing switches the coordinator to observing', async () => {
  const { coordinator } = setup({ profiles: [profile({ latest_job: job() })] })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  const toggle = await screen.findByLabelText('Use this device to analyze') as HTMLInputElement
  await waitFor(() => expect(toggle.checked).toBe(true))
  fireEvent.click(toggle)

  await waitFor(() => expect(coordinator.computeCalls).toEqual([false]))
})

test('phones default to observing only', async () => {
  const { api } = setup({ recommended: false })
  const toggle = await screen.findByLabelText('Use this device to analyze') as HTMLInputElement
  expect(toggle.checked).toBe(false)
  const analyze = screen.getByRole('button', { name: 'Analyze my games' }) as HTMLButtonElement
  await waitFor(() => expect(analyze.disabled).toBe(false))
  fireEvent.click(analyze)
  await waitFor(() => expect(api.createJob).toHaveBeenCalledWith('player-1', false))
})

test('stopping keeps completed results available', async () => {
  const { coordinator } = setup({ artifacts: true, profiles: [profile({ latest_job: job(), has_results: true })] })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop following' }))

  expect(await screen.findByText(/You stopped following this analysis/)).toBeTruthy()
  expect(coordinator.stopped).toBe(true)
  expect(screen.getByText('Opening')).toBeTruthy()
})

test('unsupported browsers see a compatibility message and cannot compute', async () => {
  setup({ supported: false })
  expect(await screen.findByText(/lacks WebAssembly/)).toBeTruthy()
  expect((screen.getByLabelText('Use this device to analyze') as HTMLInputElement).disabled).toBe(true)
})

test('worker errors are surfaced', async () => {
  const { coordinator } = setup({ profiles: [profile({ latest_job: job() })] })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  coordinator.emit({ state: 'failed', job: job({ status: 'queued', worker_active: false }), message: 'This browser is out of storage space for analysis.' })

  expect(await screen.findByText('This browser is out of storage space for analysis.')).toBeTruthy()
})

test('read-only players keep results but cannot start analysis', async () => {
  setup({ profiles: [profile({ slot_type: 'paid', state: 'read_only' })] })
  expect(await screen.findByText(/read-only until your subscription is renewed/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Analyze my games' }) as HTMLButtonElement).disabled).toBe(true)
})

test('disabled hosted analysis still shows the player', async () => {
  setup({ analysisEnabled: false })
  expect(await screen.findByText(/Shared analysis is not enabled yet/)).toBeTruthy()
})
