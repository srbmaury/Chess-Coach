import { expect, test } from 'vitest'

import { Explainer, type ExplainablePuzzle } from './explanations'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// White to move; Qh5xf7 is mate (Scholar's mate).
const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'

const base: ExplainablePuzzle = {
  puzzle_id: 'p1', fen: START, best_move_uci: 'd2d4', best_move_san: 'd4', your_move_uci: 'a2a3',
  your_move_san: 'a3', motif: 'positional / calculation', evaluation_loss_pawns: 1.25,
}
const engine = (pv: string[] | Error) => () => ({
  search: async () => { if (pv instanceof Error) throw pv; return [{ score: { cp: 30 }, pv }] },
})

test('engine-grounded explanation with the best line in SAN and the loss in pawns', async () => {
  const result = await new Explainer(engine(['d2d4', 'd7d5', 'c2c4']), 14).explain(base)

  expect(result).toMatchObject({
    idea: 'Best continuation', best_line: ['d4', 'd5', 'c4'], engine_grounded: true, depth: 14, cached: false,
  })
  expect(result.why_your_move_was_worse).toBe(
    'Your game move a3 missed this continuation and lost about 1.25 pawns of evaluation compared with the best move.')
})

test('checkmate, captures, and tactical motifs are described from the board', async () => {
  const mate = await new Explainer(engine(['h5f7']), 14).explain({ ...base, fen: SCHOLAR, best_move_uci: 'h5f7', best_move_san: 'Qxf7#' })
  expect(mate.idea).toBe('Checkmate')
  const motif = await new Explainer(engine(['d2d4']), 14).explain({ ...base, motif: 'pin' })
  expect(motif.idea).toBe('Pin')
})

test('a move that hangs a piece is named, and mate-level losses are called decisive', async () => {
  // After 1.e4 d5, Qg4?? walks into Bc8xg4 for free (text checked against explanations.py).
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
  const result = await new Explainer(engine(['g1f3']), 14).explain({
    ...base, fen, best_move_uci: 'g1f3', best_move_san: 'Nf3', your_move_uci: 'd1g4', your_move_san: 'Qg4',
    evaluation_loss_pawns: null,
  })
  expect(result.why_your_move_was_worse).toBe(
    'Your game move Qg4 leaves the queen on g4 completely undefended - Bxg4 simply wins it for free, causing a decisive, mate-level evaluation swing.')
})

test('engine disagreement and engine failure fall back to board-only notes', async () => {
  const changed = await new Explainer(engine(['e2e4']), 14).explain(base)
  expect(changed).toMatchObject({ idea: 'Analysis changed', engine_grounded: false, best_line: ['d4'] })
  expect(changed.why).toContain('now prefers e4')

  const offline = await new Explainer(engine(new Error('down')), 14).explain(base)
  expect(offline).toMatchObject({ engine_grounded: false, best_line: ['d4'] })
  expect(offline.why.startsWith('Stockfish is unavailable')).toBe(true)
})

test('explanations are cached per puzzle position', async () => {
  const explainer = new Explainer(engine(['d2d4']), 14)
  await explainer.explain(base)
  expect((await explainer.explain(base)).cached).toBe(true)
})
