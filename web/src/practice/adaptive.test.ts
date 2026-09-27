// Mirrors tests/test_adaptive_practice.py so the browser port keeps the same rules.
import { Chess } from 'chess.js'
import { expect, test, vi } from 'vitest'

import { pythonFen } from '../analysis/board'
import type { EngineLine, UciScore } from '../analysis/classify'
import { AdaptivePractice, type DrillOutcome } from './adaptive'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const PUZZLE = { puzzle_id: 'p1', fen: START, orientation: 'white', best_move_uci: 'd2d4' }
const REVIEW = { next_interval_days: 3, next_review_at: '2026-09-30T00:00:00Z', consecutive_correct: 1, mastered: false }

function position(...moves: string[]): string {
  const chess = new Chess(START)
  for (const move of moves) chess.move({ from: move.slice(0, 2), to: move.slice(2, 4) })
  return pythonFen(chess)
}

/** A score given from White's point of view, as the Python tests script it. */
function info(fen: string, white: UciScore, ...pv: string[]): [string, EngineLine] {
  const blackToMove = fen.split(' ')[1] === 'b'
  const score = 'cp' in white
    ? { cp: blackToMove ? -white.cp : white.cp }
    : { mate: blackToMove ? -white.mate : white.mate }
  return [fen, { score, pv }]
}

function practice(script: [string, EngineLine | Error][]) {
  const table = new Map(script)
  const calls: string[] = []
  const complete = vi.fn(async (_id: string, _outcome: DrillOutcome) => REVIEW)
  const engine = {
    search: async (fen: string) => {
      calls.push(fen)
      const result = table.get(fen)
      if (result instanceof Error) throw result
      if (!result) throw new Error(`No scripted analysis for ${fen}`)
      return [result]
    },
  }
  let id = 0
  return { adaptive: new AdaptivePractice(() => engine, complete, () => `s${++id}`), calls, complete }
}

test('the exact expected move is accepted without a candidate search', async () => {
  const { adaptive, calls, complete } = practice([
    info(position(), { cp: 100 }, 'd2d4', 'd7d5', 'g1f3'),
    info(position('d2d4'), { cp: 100 }, 'd7d5', 'g1f3'),
  ])
  const session = await adaptive.start(PUZZLE)
  const result = await adaptive.move(session.session_id, 'd2d4')

  expect(result).toMatchObject({ accepted: true, status: 'active', eval_loss_cp: 0, engine_reply_uci: 'd7d5' })
  expect(result.current_fen).toBe(position('d2d4', 'd7d5'))
  expect(calls).toHaveLength(2)
  expect(complete).not.toHaveBeenCalled()
})

test('an alternative within 30 cp is accepted and the line branches', async () => {
  const { adaptive } = practice([
    info(position(), { cp: 100 }, 'd2d4', 'd7d5'),
    info(position('c2c4'), { cp: 80 }, 'e7e5', 'g1f3'),
  ])
  const session = await adaptive.start(PUZZLE)
  const result = await adaptive.move(session.session_id, 'c2c4')

  expect(result).toMatchObject({ accepted: true, eval_loss_cp: 20, engine_reply_uci: 'e7e5' })
  expect(result.current_fen).toBe(position('c2c4', 'e7e5'))
})

test('an alternative beyond 30 cp keeps the position for a retry', async () => {
  const { adaptive, complete } = practice([
    info(position(), { cp: 100 }, 'd2d4'),
    info(position('c2c4'), { cp: 69 }, 'e7e5'),
  ])
  const session = await adaptive.start(PUZZLE)
  const first = await adaptive.move(session.session_id, 'c2c4')
  const repeated = await adaptive.move(session.session_id, 'c2c4')

  expect(first).toMatchObject({ accepted: false, status: 'active', eval_loss_cp: 31, current_fen: START, current_ply: 0 })
  expect(repeated).toMatchObject({ status: 'active', current_fen: START, user_moves_attempted: 2 })
  expect(complete).not.toHaveBeenCalled()
})

test('a forced winning mate must be preserved', async () => {
  const lost = practice([info(position(), { mate: 3 }, 'd2d4'), info(position('c2c4'), { cp: 500 }, 'e7e5')])
  const session = await lost.adaptive.start(PUZZLE)
  expect(await lost.adaptive.move(session.session_id, 'c2c4')).toMatchObject({ accepted: false, current_fen: START })

  const kept = practice([info(position(), { mate: 3 }, 'd2d4'), info(position('c2c4'), { mate: 4 }, 'e7e5', 'g1f3')])
  const again = await kept.adaptive.start(PUZZLE)
  const result = await kept.adaptive.move(again.session_id, 'c2c4')
  expect(result.accepted).toBe(true)
  expect(result.current_fen).toBe(position('c2c4', 'e7e5'))
})

test('an illegal move is rejected without touching the session or engine', async () => {
  const { adaptive, calls } = practice([])
  const session = await adaptive.start(PUZZLE)

  await expect(adaptive.move(session.session_id, 'e2e5')).rejects.toMatchObject({ status: 422 })
  const state = await adaptive.abandon(session.session_id)
  expect(state).toMatchObject({ user_moves_attempted: 0, current_fen: START })
  expect(calls).toEqual([])
})

test('a quiet, stable position after two decisions completes the drill', async () => {
  const { adaptive, complete } = practice([
    info(position(), { cp: 100 }, 'd2d4', 'd7d5', 'g1f3'),
    info(position('d2d4'), { cp: 100 }, 'd7d5', 'g1f3'),
    info(position('d2d4', 'd7d5', 'g1f3'), { cp: 100 }, 'g8f6', 'c2c4'),
    info(position('d2d4', 'd7d5', 'g1f3', 'g8f6'), { cp: 105 }, 'c2c4'),
  ])
  const session = await adaptive.start(PUZZLE)
  expect((await adaptive.move(session.session_id, 'd2d4')).status).toBe('active')

  const second = await adaptive.move(session.session_id, 'g1f3')

  expect(second).toMatchObject({ accepted: true, status: 'succeeded', review: REVIEW })
  expect(second.current_fen).toBe(position('d2d4', 'd7d5', 'g1f3', 'g8f6'))
  expect(complete).toHaveBeenCalledWith('p1', {
    succeeded: true, answer: 'd2d4', user_moves_accepted: 2, current_ply: 4,
    continuation_attempts: 1, continuation_correct: 1,
  })
})

test('the fourth accepted decision finishes without an engine reply', async () => {
  const line = ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c2c4', 'e7e6', 'b1c3']
  const { adaptive, complete } = practice([
    info(position(), { cp: 100 }, 'd2d4', 'd7d5', 'g1f3'),
    info(position(...line.slice(0, 1)), { cp: 100 }, 'd7d5', 'g1f3'),
    info(position(...line.slice(0, 3)), { cp: 100 }, 'g8f6', 'c2c4'),
    // A winning mate keeps the drill going past the quiet-position check.
    info(position(...line.slice(0, 4)), { mate: 5 }, 'c2c4', 'e7e6'),
    info(position(...line.slice(0, 5)), { mate: 5 }, 'e7e6', 'b1c3'),
    info(position(...line.slice(0, 6)), { mate: 4 }, 'b1c3'),
  ])
  const session = await adaptive.start(PUZZLE)
  for (const move of ['d2d4', 'g1f3', 'c2c4']) {
    expect((await adaptive.move(session.session_id, move)).status).toBe('active')
  }
  const last = await adaptive.move(session.session_id, 'b1c3')

  expect(last).toMatchObject({ status: 'succeeded', engine_reply_uci: null, current_ply: 7 })
  expect(complete).toHaveBeenCalledWith('p1', expect.objectContaining({
    succeeded: true, user_moves_accepted: 4, current_ply: 7, continuation_attempts: 3, continuation_correct: 3,
  }))
})

test('an engine failure leaves the session active and unpenalized', async () => {
  const { adaptive } = practice([[position(), new Error('engine unavailable')]])
  const session = await adaptive.start(PUZZLE)

  await expect(adaptive.move(session.session_id, 'd2d4')).rejects.toMatchObject({ status: 503 })
  expect(await adaptive.abandon(session.session_id)).toMatchObject({ user_moves_attempted: 0, current_fen: START })
})

test('a hint reveals the best move and makes a perfect drill count as assisted once', async () => {
  const { adaptive, complete } = practice([
    info(position(), { cp: 100 }, 'd2d4', 'd7d5'),
    info(position('d2d4'), { cp: 100 }, 'd7d5'),
  ])
  const session = await adaptive.start(PUZZLE)
  const hint = await adaptive.hint(session.session_id)
  const again = await adaptive.hint(session.session_id)

  expect(hint).toMatchObject({ move_uci: 'd2d4', move_san: 'd4', user_moves_attempted: 1, user_moves_accepted: 0 })
  expect(again.user_moves_attempted).toBe(1)
  expect(complete).not.toHaveBeenCalled()
})

test('starting again resumes the active drill; abandoned drills stop accepting moves', async () => {
  const { adaptive } = practice([])
  const first = await adaptive.start(PUZZLE)
  expect((await adaptive.start(PUZZLE)).session_id).toBe(first.session_id)

  const abandoned = await adaptive.abandon(first.session_id)
  expect(abandoned.status).toBe('abandoned')
  expect((await adaptive.move(first.session_id, 'd2d4')).accepted).toBeNull()
  await expect(adaptive.move('missing', 'd2d4')).rejects.toMatchObject({ status: 404 })
  expect((await adaptive.start(PUZZLE)).session_id).not.toBe(first.session_id)
})
