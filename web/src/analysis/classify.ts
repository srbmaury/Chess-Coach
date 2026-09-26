// Move classification ported from engine.py and move_quality.py (scoring version 3).
// Scores follow python-chess semantics exactly, including "MateGiven" (the side to
// move has just been mated, seen from the other side).
import { Chess } from 'chess.js'

import { Board, afterMove, material, parseUci, pythonFen, type Color } from './board'

export const MATE_CP = 100_000
export const MATE_THRESHOLD_CP = 50_000
export const SCORING_VERSION = 3

export type Score =
  | { kind: 'cp'; cp: number }
  | { kind: 'mate'; moves: number }
  | { kind: 'mate_given' }

/** A UCI engine score, always from the side to move's point of view. */
export type UciScore = { cp: number } | { mate: number }

export type EngineLine = { score: UciScore; pv: string[] }

export function fromUci(score: UciScore): Score {
  return 'cp' in score ? { kind: 'cp', cp: score.cp } : { kind: 'mate', moves: score.mate }
}

export function negate(score: Score): Score {
  if (score.kind === 'cp') return { kind: 'cp', cp: -score.cp }
  if (score.kind === 'mate_given') return { kind: 'mate', moves: 0 }
  return score.moves === 0 ? { kind: 'mate_given' } : { kind: 'mate', moves: -score.moves }
}

/** PovScore(score, turn).pov(color) */
export function pov(score: UciScore, turn: Color, color: Color): Score {
  const relative = fromUci(score)
  return turn === color ? relative : negate(relative)
}

export function scoreValue(score: Score, mateScore = MATE_CP): number {
  if (score.kind === 'cp') return score.cp
  if (score.kind === 'mate_given') return mateScore
  return score.moves > 0 ? mateScore - score.moves : -mateScore - score.moves
}

function mateOf(score: Score): number | null {
  if (score.kind === 'cp') return null
  return score.kind === 'mate_given' ? 0 : score.moves
}

// python-chess `_sf16_wins` (Stockfish 16 win-rate model).
function sf16Wins(cp: number, ply: number): number {
  const m = Math.min(240, Math.max(ply, 0)) / 64
  const a = (((0.38036525 * m + -2.8201507) * m + 23.17882135) * m) + 307.36768407
  const b = (((-2.29434733 * m + 13.27689788) * m + -14.26828904) * m) + 63.4531833
  const x = Math.min(4000, Math.max((cp * 328) / 100, -4000))
  return Math.trunc(0.5 + 1000 / (1 + Math.exp((a - x) / b)))
}

function expectedScore(score: Score, ply: number): number {
  let wins: number
  let losses: number
  if (score.kind === 'cp') {
    wins = sf16Wins(score.cp, ply)
    losses = sf16Wins(-score.cp, ply)
  } else if (score.kind === 'mate_given' || score.moves > 0) {
    wins = 1000
    losses = 0
  } else {
    wins = 0
    losses = 1000
  }
  const draws = 1000 - wins - losses
  return (wins + 0.5 * draws) / 1000
}

export type ScoreSnapshot = { cp: number | null; mate: number | null; expectedScore: number }

export function scoreSnapshot(score: UciScore, turn: Color, user: Color, ply = 30): ScoreSnapshot {
  const relative = pov(score, turn, user)
  const rawMate = mateOf(relative)
  if (rawMate === null) {
    return { cp: (relative as { cp: number }).cp, mate: null, expectedScore: expectedScore(relative, Math.max(1, ply)) }
  }
  const normalized = scoreValue(relative)
  const distance = Math.abs(rawMate)
  const signed = normalized >= 0 ? distance : -distance
  const expected = normalized > 0 ? 1 : normalized < 0 ? 0 : expectedScore(relative, Math.max(1, ply))
  return { cp: null, mate: signed, expectedScore: expected }
}

export type MoveAssessment = { label: string; reason: string }

const winningMate = (score: ScoreSnapshot) => score.mate !== null && score.expectedScore >= 0.999
const losingMate = (score: ScoreSnapshot) => score.mate !== null && score.expectedScore <= 0.001

export function classifyMoveQuality(input: {
  before: ScoreSnapshot
  after: ScoreSnapshot
  cpl: number
  isBestMove: boolean
  brilliantCandidate?: boolean
  deliveredMate?: boolean
}): MoveAssessment {
  const { before, after, isBestMove } = input
  const cpl = Math.max(0, Math.trunc(input.cpl))
  const drop = Math.max(0, before.expectedScore - after.expectedScore)
  if (input.deliveredMate) return { label: 'best', reason: 'delivers checkmate' }
  if (winningMate(before) && !winningMate(after)) return { label: 'miss', reason: 'forced mate was available' }
  if (losingMate(after) && !losingMate(before)) return { label: 'blunder', reason: 'allows forced mate' }
  if (before.expectedScore >= 0.9 && after.expectedScore <= 0.65 && drop >= 0.25) {
    return { label: 'miss', reason: 'decisive winning chance was missed' }
  }
  if (input.brilliantCandidate && cpl <= 30 && drop <= 0.03 && after.expectedScore >= 0.7) {
    return { label: 'brilliant', reason: 'sound sacrifice and uniquely strong move' }
  }
  if (isBestMove) return { label: 'best', reason: 'engine top move' }
  if (cpl <= 10 && drop <= 0.01) return { label: 'best', reason: 'engine-equivalent move' }
  if (drop >= 0.3) return { label: 'blunder', reason: 'large drop in expected score' }
  if (drop >= 0.15) return { label: 'mistake', reason: 'significant drop in expected score' }
  if (drop >= 0.05) return { label: 'inaccuracy', reason: 'noticeable drop in expected score' }
  if (cpl <= 30 && drop <= 0.02) return { label: 'excellent', reason: 'near-best move' }
  return { label: 'good', reason: 'outcome essentially preserved' }
}

export function sacrificesMaterialAfterReply(
  beforeFen: string,
  afterFen: string,
  user: Color,
  reply: string | null,
  minimumMaterial = 2,
): boolean {
  if (!reply) return false
  const replied = afterMove(afterFen, reply)
  if (!replied) return false
  const lost = material(new Board(beforeFen), user) - material(new Board(pythonFen(replied)), user)
  return lost >= minimumMaterial
}

export function alternativesShowUniqueness(lines: EngineLine[], turn: Color, user: Color, ply = 30): boolean {
  if (lines.length < 2) return false
  const first = scoreSnapshot(lines[0].score, turn, user, ply)
  const second = scoreSnapshot(lines[1].score, turn, user, ply)
  if (winningMate(first) && !winningMate(second)) return true
  if (first.expectedScore - second.expectedScore >= 0.08) return true
  return first.cp !== null && second.cp !== null && first.cp - second.cp >= 100
}

export type AnalysisRow = {
  ply: number
  best_move_uci: string | null
  eval_before_cp: number
  eval_after_cp: number
  mate_before: number | null
  mate_after: number | null
  expected_score_before: number
  expected_score_after: number
  cpl: number
  quality: string
  quality_reason: string
}

/** The engine searches a user move needs, in the order the Python pipeline makes them. */
export interface MoveEngine {
  search(fen: string, multipv: number): Promise<EngineLine[]>
}

function roundTo6(value: number): number {
  // Expected scores are k/2000, which round(…, 6) leaves unchanged; keep the call
  // explicit so any future model change is caught by parity tests.
  return Math.round(value * 1e6) / 1e6
}

export async function analyzeUserMove(input: {
  engine: MoveEngine
  beforeFen: string
  afterFen: string
  ply: number
  playedUci: string
  user: Color
  multipv: number
}): Promise<AnalysisRow> {
  const { engine, beforeFen, afterFen, ply, playedUci, user } = input
  const [before] = await engine.search(beforeFen, 1)
  const [after] = await engine.search(afterFen, 1)
  const beforeTurn = beforeFen.split(' ')[1] as Color
  const afterTurn = afterFen.split(' ')[1] as Color
  const beforeEval = scoreValue(pov(before.score, beforeTurn, user))
  const afterEval = scoreValue(pov(after.score, afterTurn, user))
  const beforeSnapshot = scoreSnapshot(before.score, beforeTurn, user, ply)
  const afterSnapshot = scoreSnapshot(after.score, afterTurn, user, ply + 1)
  const bestMove = before.pv[0] ?? null
  const deliveredMate = new Chess(afterFen).isCheckmate()
  const isBestMove = bestMove !== null && bestMove === playedUci
  const cpl = isBestMove || deliveredMate ? 0 : Math.max(0, beforeEval - afterEval)

  let brilliantCandidate = false
  if (isBestMove && !deliveredMate && afterSnapshot.expectedScore >= 0.7) {
    const reply = after.pv[0] ?? null
    if (sacrificesMaterialAfterReply(beforeFen, afterFen, user, reply)) {
      const lines = await engine.search(beforeFen, Math.max(2, input.multipv))
      brilliantCandidate = alternativesShowUniqueness(lines, beforeTurn, user)
    }
  }
  const assessment = classifyMoveQuality({
    before: beforeSnapshot,
    after: afterSnapshot,
    cpl,
    isBestMove,
    brilliantCandidate,
    deliveredMate,
  })
  return {
    ply,
    best_move_uci: bestMove,
    eval_before_cp: beforeEval,
    eval_after_cp: afterEval,
    mate_before: beforeSnapshot.mate,
    mate_after: afterSnapshot.mate,
    expected_score_before: roundTo6(beforeSnapshot.expectedScore),
    expected_score_after: roundTo6(afterSnapshot.expectedScore),
    cpl,
    quality: assessment.label,
    quality_reason: assessment.reason,
  }
}

export type ManifestGame = {
  game_id: string
  user_color: 'white' | 'black'
  game_date: string | null
  white: string
  black: string
  white_rating: number | null
  black_rating: number | null
  result: string | null
  time_control: string | null
  rated: boolean | null
  eco: string | null
  opening: string | null
  source_url: string | null
  moves: string[]
  clocks: (number | null)[]
}

export type GamePosition = {
  ply: number
  fullmoveNumber: number
  color: 'white' | 'black'
  fenBefore: string
  fenAfter: string
  san: string
  uci: string
  isUserMove: boolean
  clockSeconds: number | null
}

/** Replay a manifest game into python-chess-compatible positions. */
export function gamePositions(game: ManifestGame): GamePosition[] {
  const chess = new Chess()
  const positions: GamePosition[] = []
  game.moves.forEach((uci, index) => {
    const fenBefore = pythonFen(chess)
    const turn = chess.turn()
    const fullmoveNumber = Number(chess.fen().split(' ')[5])
    const move = chess.move(parseUci(uci))
    const color = turn === 'w' ? 'white' : 'black'
    positions.push({
      ply: index + 1,
      fullmoveNumber,
      color,
      fenBefore,
      fenAfter: pythonFen(chess),
      san: move.san,
      uci,
      isUserMove: color === game.user_color,
      clockSeconds: game.clocks[index] ?? null,
    })
  })
  return positions
}

/** Analyze every user move of one game, in ply order. */
export async function analyzeGame(
  game: ManifestGame,
  engine: MoveEngine,
  options: { multipv: number; signal?: AbortSignal },
): Promise<AnalysisRow[]> {
  const rows: AnalysisRow[] = []
  const user: Color = game.user_color === 'white' ? 'w' : 'b'
  for (const position of gamePositions(game)) {
    if (!position.isUserMove) continue
    if (options.signal?.aborted) throw new DOMException('Analysis stopped', 'AbortError')
    rows.push(await analyzeUserMove({
      engine,
      beforeFen: position.fenBefore,
      afterFen: position.fenAfter,
      ply: position.ply,
      playedUci: position.uci,
      user,
      multipv: options.multipv,
    }))
  }
  return rows
}
