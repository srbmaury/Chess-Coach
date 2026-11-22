import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position: string; allowDragging?: boolean; onPieceDrop?: (move: { sourceSquare: string; targetSquare: string }) => boolean } }) => (
    <div>
      <span data-testid="board-position">{options.position}</span>
      <span data-testid="board-dragging">{String(options.allowDragging)}</span>
      <button aria-label="Play c4" onClick={() => options.onPieceDrop?.({ sourceSquare: 'c2', targetSquare: 'c4' })}>Play c4</button>
    </div>
  ),
}))

import LegacyApp from './LegacyApp'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const puzzle = {
  puzzle_id: 'p1',
  fen: START,
  orientation: 'white',
  game: 'player vs opponent',
  move: '1.e4',
  opening: "Queen's Pawn Opening",
  eco: 'D00',
  phase: 'opening',
  motif: 'positional / calculation',
  difficulty: 3,
}

const activeSession = {
  session_id: 's1',
  puzzle_id: 'p1',
  status: 'active',
  current_fen: START,
  orientation: 'white',
  user_moves_attempted: 0,
  user_moves_accepted: 0,
  current_ply: 0,
  max_eval_loss_cp: 0,
  max_user_decisions: 4,
  steps: [],
  review: null,
}

function response(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

test('rejected adaptive moves keep the same board retryable without revealing the solution', async () => {
  window.history.pushState({}, '', '/practice')
  let attempts = 0
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url === '/api/practice/next') return response({ puzzle })
    if (url === '/api/practice/p1/adaptive/start') return response(activeSession)
    if (url === '/api/practice/adaptive/s1/move') {
      attempts += 1
      return response({
        ...activeSession,
        accepted: false,
        move_uci: 'c2c4',
        move_san: 'c4',
        eval_loss_cp: 50,
        current_fen: START,
        user_moves_attempted: attempts,
        user_moves_accepted: 0,
        current_ply: 0,
        max_eval_loss_cp: 50,
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<LegacyApp />)
  await screen.findByText('White to move')

  fireEvent.click(screen.getByRole('button', { name: 'Play c4' }))
  await waitFor(() => expect(screen.getByTestId('board-dragging').textContent).toBe('true'))
  expect(screen.getByTestId('board-position').textContent).toBe(START)
  expect(screen.getByText('Not quite. Try again — the position stays the same.')).toBeTruthy()
  expect(screen.queryByText('Line so far')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Play c4' }))
  await waitFor(() => expect(attempts).toBe(2))
  expect(screen.getByTestId('board-position').textContent).toBe(START)
  expect(screen.getByTestId('board-dragging').textContent).toBe('true')
  expect(document.body.textContent).not.toContain('Best move:')
  expect(document.body.textContent).not.toContain('d2d4')
})

test('adaptive start can retry the current puzzle after a transient failure', async () => {
  window.history.pushState({}, '', '/practice')
  let starts = 0
  let nextRequests = 0
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url === '/api/practice/next') {
      nextRequests += 1
      return response({ puzzle })
    }
    if (url === '/api/practice/p1/adaptive/start') {
      starts += 1
      if (starts === 1) throw new Error('Temporary connection failure')
      return response(activeSession)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  render(<LegacyApp />)
  const retry = await screen.findByRole('button', { name: 'Retry' })
  expect(screen.getByText('Temporary connection failure')).toBeTruthy()
  expect(screen.getByTestId('board-dragging').textContent).toBe('false')

  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByTestId('board-dragging').textContent).toBe('true'))
  expect(screen.queryByText('Temporary connection failure')).toBeNull()
  expect(nextRequests).toBe(1)
  expect(starts).toBe(2)
})
