import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'

import { setApiTransport } from '../apiTransport'
import { HostedContext, type HostedEnvironment } from '../hostedContext'
import type { CoordinatorSnapshot } from './coordinator'
import HostedPipelinePage from './HostedPipelinePage'
import type { CoordinatorLike, HostedServices } from './services'
import type { JobView, ProfileView } from './types'

afterEach(() => {
  cleanup()
  setApiTransport(null)
})

const job = (changes: Partial<JobView> = {}): JobView => ({
  id: 'job-1', player_id: 'player-1', status: 'running', completed_units: 3, total_units: 10, checkpoint_sequence: 1,
  analysis_config_hash: 'c', manifest_hash: 'm', compute_source: 'community_computed', worker_active: true,
  subscription_state: 'active', can_compute: true, updated_at: '2026-09-27T00:00:00Z', finished_at: null, ...changes,
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
  subscribe(listener: (snapshot: CoordinatorSnapshot) => void) { this.listener = listener; return () => undefined }
  async start(jobId: string) { this.started.push(jobId) }
  nudge() {}
  async setComputeAllowed(allowed: boolean) { this.computeCalls.push(allowed) }
  async stopObserving() {
    this.stopped = true
    this.emit({ state: 'stopped', job: job({ subscription_state: 'stopped', worker_active: false }) })
  }
  dispose() {}
  emit(snapshot: Partial<CoordinatorSnapshot>) {
    this.listener?.({ state: 'observing', job: null, localUnits: 0, resumed: false, message: null, ...snapshot })
  }
}

function setup(options: { profile?: ProfileView; supported?: boolean; recommended?: boolean; analysisEnabled?: boolean } = {}) {
  const coordinator = new FakeCoordinator()
  const current = options.profile ?? profile()
  const api = {
    profiles: vi.fn(async () => ({ analysis_enabled: options.analysisEnabled ?? true, profiles: [current] })),
    createJob: vi.fn(async (_player: string, canCompute: boolean) => job({ completed_units: 0, worker_active: false, can_compute: canCompute })),
  }
  setApiTransport(async (path) => {
    if (path === '/api/profiles') return new Response(JSON.stringify({ active_username: current.username, profiles: [] }))
    return new Response('{}', { status: 404 })
  })
  const services = {
    createApi: () => api,
    capabilities: async () => ({
      supported: options.supported ?? true, recommended: options.recommended ?? true,
      reason: options.supported === false ? 'This browser lacks WebAssembly; it can follow progress but not compute.' : null,
    }),
    createCoordinator: vi.fn(async () => coordinator),
    subscribeProgress: vi.fn(async () => ({ close: () => undefined })),
  } as unknown as HostedServices
  const hosted = { session: { access_token: 't' }, services, config: {}, email: 'p@example.test', signOut: () => undefined } as unknown as HostedEnvironment
  render(<HostedContext.Provider value={hosted}><MemoryRouter><HostedPipelinePage /></MemoryRouter></HostedContext.Provider>)
  return { api, coordinator }
}

async function analyzeButton(name: string) {
  const button = await screen.findByRole('button', { name }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

test('starting analysis syncs games with the device choice and follows the shared job', async () => {
  const { api, coordinator } = setup()
  fireEvent.click(await analyzeButton('Analyze my games'))

  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  expect(api.createJob).toHaveBeenCalledWith('player-1', true)
  coordinator.emit({ state: 'observing', job: job(), message: 'Another browser is analyzing' })
  expect(await screen.findByText('Another browser is analyzing')).toBeTruthy()
  expect(screen.getByText('3 / 10')).toBeTruthy()
  expect(screen.getByText('10 Chess.com games')).toBeTruthy()
})

test('a takeover shows it resumed from the last checkpoint', async () => {
  const { coordinator } = setup({ profile: profile({ latest_job: job() }) })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  coordinator.emit({ state: 'running', resumed: true, localUnits: 2, job: job({ completed_units: 5, worker_active: true }) })

  expect(await screen.findByText('Resumed from the last saved checkpoint.')).toBeTruthy()
  expect(screen.getByText('5 / 10')).toBeTruthy()
  expect(screen.getByText('This device')).toBeTruthy()
})

test('opting out makes this browser observe; phones default to observing', async () => {
  const { coordinator } = setup({ profile: profile({ latest_job: job() }) })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  const toggle = await screen.findByLabelText('Use this device to analyze') as HTMLInputElement
  await waitFor(() => expect(toggle.checked).toBe(true))
  fireEvent.click(toggle)
  await waitFor(() => expect(coordinator.computeCalls).toEqual([false]))

  cleanup()
  const phone = setup({ recommended: false })
  const phoneToggle = await screen.findByLabelText('Use this device to analyze') as HTMLInputElement
  expect(phoneToggle.checked).toBe(false)
  fireEvent.click(await analyzeButton('Analyze my games'))
  await waitFor(() => expect(phone.api.createJob).toHaveBeenCalledWith('player-1', false))
})

test('stopping keeps finished results and offers to analyze again', async () => {
  const { coordinator } = setup({ profile: profile({ latest_job: job(), has_results: true }) })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop following' }))

  expect(await screen.findByText(/You stopped following this analysis/)).toBeTruthy()
  expect(coordinator.stopped).toBe(true)
  expect(await screen.findByRole('button', { name: 'Update with new games' })).toBeTruthy()
})

test('a finished analysis marks every stage done and links to practice', async () => {
  setup({ profile: profile({ latest_job: job({ status: 'succeeded', completed_units: 10, subscription_state: 'completed' }), has_results: true }) })
  expect(await screen.findByRole('link', { name: 'Start practice' })).toBeTruthy()
  expect(screen.getAllByText('Done')).toHaveLength(4)
  expect(screen.getByText(/community computed/)).toBeTruthy()
})

test('unsupported browsers, read-only players, and disabled analysis are explained', async () => {
  setup({ supported: false })
  expect(await screen.findByText(/lacks WebAssembly/)).toBeTruthy()
  expect((screen.getByLabelText('Use this device to analyze') as HTMLInputElement).disabled).toBe(true)
  cleanup()

  setup({ profile: profile({ slot_type: 'paid', state: 'read_only' }) })
  expect(await screen.findByText(/read-only until your subscription is renewed/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Analyze my games' }) as HTMLButtonElement).disabled).toBe(true)
  cleanup()

  setup({ analysisEnabled: false })
  expect(await screen.findByText(/Analysis is not enabled yet/)).toBeTruthy()
})

test('worker errors are surfaced', async () => {
  const { coordinator } = setup({ profile: profile({ latest_job: job() }) })
  await waitFor(() => expect(coordinator.started).toEqual(['job-1']))
  coordinator.emit({ state: 'failed', job: job({ status: 'queued', worker_active: false }), message: 'This browser is out of storage space for analysis.' })

  expect(await screen.findByText('This browser is out of storage space for analysis.')).toBeTruthy()
  expect(screen.getByText('Stopped')).toBeTruthy()
})
