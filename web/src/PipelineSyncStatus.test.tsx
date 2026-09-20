import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('react-chessboard', () => ({
  Chessboard: () => null,
}))

import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const activeProfiles = {
  active_username: 'srbmaury',
  profiles: [{ username: 'srbmaury', display_username: 'srbmaury' }],
}

function installPipeline(status: Record<string, unknown>) {
  let source: FakeEventSource | null = null
  class FakeEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null
    constructor(_url: string) {
      source = this
    }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === '/api/profiles') {
        return { ok: true, json: async () => activeProfiles } as Response
      }
      if (url === '/api/pipeline/status') {
        return { ok: true, json: async () => status } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }),
  )
  return () => source
}

function emit(source: { onmessage: ((event: MessageEvent) => void) | null } | null, payload: Record<string, unknown>) {
  source?.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
}

test('shows sync progress in months', async () => {
  window.history.pushState({}, '', '/pipeline')
  const getSource = installPipeline({ status: 'running', stage: 'sync', username: 'srbmaury' })

  render(<App />)
  expect(await screen.findByText('Build your coach')).toBeTruthy()
  await waitFor(() => expect(getSource()).not.toBeNull())

  emit(getSource(), {
    stage: 'sync',
    status: 'running',
    current_month: 7,
    total_months: 25,
    archive_month: '2026-03',
    games_synced: 321,
    archive_skipped: false,
  })

  expect(await screen.findByText('current month')).toBeTruthy()
  expect(screen.getByText('total months')).toBeTruthy()
  expect(screen.getByText('games synced')).toBeTruthy()
  expect(screen.getByText('archive month')).toBeTruthy()
  expect(screen.getByText('7')).toBeTruthy()
  expect(screen.getByText('25')).toBeTruthy()
})

test('shows analyze and puzzles progress with meaningful units', async () => {
  window.history.pushState({}, '', '/pipeline')
  const getSource = installPipeline({ status: 'running', stage: 'analyze', username: 'srbmaury' })

  render(<App />)
  expect(await screen.findByText('Build your coach')).toBeTruthy()
  await waitFor(() => expect(getSource()).not.toBeNull())

  emit(getSource(), {
    stage: 'analyze',
    status: 'running',
    completed_moves: 121537,
    total_user_moves: 211639,
    reused_analyses: 120000,
    newly_analyzed_moves: 1537,
  })

  expect(await screen.findByText('completed moves')).toBeTruthy()
  expect(screen.getByText('total user moves')).toBeTruthy()
  expect(screen.getByText('reused analyses')).toBeTruthy()
  expect(screen.getByText('newly analyzed moves')).toBeTruthy()

  emit(getSource(), {
    stage: 'puzzles',
    status: 'running',
    processed_feature_rows: 1000,
    total_feature_rows: 121537,
    eligible_puzzles: 213,
  })

  expect(await screen.findByText('processed feature rows')).toBeTruthy()
  expect(screen.getByText('total feature rows')).toBeTruthy()
  expect(screen.getByText('eligible puzzles')).toBeTruthy()
})

test('renders flattened train results instead of object strings', async () => {
  window.history.pushState({}, '', '/pipeline')
  const getSource = installPipeline({ status: 'running', stage: 'train', username: 'srbmaury' })

  render(<App />)
  expect(await screen.findByText('Build your coach')).toBeTruthy()
  await waitFor(() => expect(getSource()).not.toBeNull())

  emit(getSource(), {
    stage: 'train',
    status: 'succeeded',
    model_file: '/tmp/mistake_model.joblib',
    metadata_file: '/tmp/mistake_model.metadata.json',
    metrics_roc_auc: 0.82,
    metrics_pr_auc: 0.64,
  })

  expect(await screen.findByText('model file')).toBeTruthy()
  expect(screen.getByText('metrics roc auc')).toBeTruthy()
  expect(screen.getByText('0.82')).toBeTruthy()
  expect(screen.getByText('metrics pr auc')).toBeTruthy()
  expect(screen.getByText('0.64')).toBeTruthy()
  expect(screen.queryByText('[object Object]')).toBeNull()
})

test('renders sync result fields instead of an object string', async () => {
  window.history.pushState({}, '', '/pipeline')
  const getSource = installPipeline({ status: 'running', stage: 'sync', username: 'srbmaury' })

  render(<App />)
  expect(await screen.findByText('Build your coach')).toBeTruthy()
  await waitFor(() => expect(getSource()).not.toBeNull())

  emit(getSource(), {
    stage: 'sync',
    status: 'succeeded',
    downloaded_games: 18,
    total_games: 339,
    pgn_file: '/tmp/srbmaury_all_games.pgn',
  })

  expect(await screen.findByText('downloaded games')).toBeTruthy()
  expect(screen.getByText('18')).toBeTruthy()
  expect(screen.getByText('total games')).toBeTruthy()
  expect(screen.getByText('339')).toBeTruthy()
  expect(screen.getByText('pgn file')).toBeTruthy()
  expect(screen.queryByText('[object Object]')).toBeNull()
})
