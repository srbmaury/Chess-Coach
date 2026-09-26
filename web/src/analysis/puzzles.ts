// Puzzle extraction ported from puzzles.py (puzzle algorithm 1).
import { Chess } from 'chess.js'

import { Board, PIECE_VALUES, afterMove, isLegalUci, parseUci, pythonFen, squareIndex, type Color } from './board'
import type { FeatureRow } from './features'
import { MATE_THRESHOLD_CP } from './classify'
import { pyRound2 } from './pyformat'
import { sha256Hex } from './hash'

export type PuzzleSeed = {
  puzzle_id: string
  game_id: string
  ply: number
  fen_before: string
  color: string
  game_label: string
  move_label: string
  your_move_san: string
  your_move_uci: string
  best_move_san: string
  best_move_uci: string
  cpl: number
  eval_loss_pawns: number | null
  quality: string
  opening: string
  eco: string
  game_phase: string
  source_url: string
  motif: string
  difficulty: number
  quality_reason: string
}

function text(value: string | number | null | undefined, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  const trimmed = String(value).trim()
  return trimmed || fallback
}

export function displayLossPawns(cpl: number, reason = ''): number | null {
  if (Math.abs(Math.trunc(cpl)) >= MATE_THRESHOLD_CP || reason.toLowerCase().includes('forced mate')) return null
  return pyRound2(Math.max(0, Math.trunc(cpl)) / 100)
}

function newlyPinnedEnemyPiece(before: Board, after: Board, enemy: Color): boolean {
  const pinned = (board: Board) => new Set(board.squares.flatMap((piece, square) =>
    piece && piece.color === enemy && piece.type !== 'k' && board.isPinned(enemy, square) ? [square] : []))
  const beforePinned = pinned(before)
  return [...pinned(after)].some((square) => !beforePinned.has(square))
}

export function classifyMotif(fen: string, bestMoveUci: string, kingRingAttacks: number | null = null): string {
  const chess = new Chess(fen)
  if (!isLegalUci(chess, bestMoveUci)) return 'positional / calculation'
  const before = new Board(fen)
  const mover = before.turn
  const enemy: Color = mover === 'w' ? 'b' : 'w'
  const { from, to, promotion } = parseUci(bestMoveUci)
  const verbose = chess.moves({ verbose: true }).find((move) =>
    move.from === from && move.to === to && (move.promotion ?? undefined) === promotion)!
  const movingPiece = before.pieceAt(squareIndex(from))
  const movingValue = movingPiece ? PIECE_VALUES[movingPiece.type] : 0
  const isCapture = verbose.flags.includes('c') || verbose.flags.includes('e')

  const played = afterMove(fen, bestMoveUci)!
  if (played.isCheckmate()) return 'missed mate'
  if (played.inCheck()) return 'forcing check'
  const after = new Board(pythonFen(played))
  const targets = after.attacks(squareIndex(to)).filter((square) => {
    const piece = after.pieceAt(square)
    return piece !== null && piece.color === enemy && piece.type !== 'k' && PIECE_VALUES[piece.type] > movingValue
  })
  if (targets.length >= 2) return 'fork'
  if (newlyPinnedEnemyPiece(before, after, enemy)) return 'pin'
  if (isCapture) return 'winning capture'
  if (kingRingAttacks !== null && Math.trunc(kingRingAttacks) >= 3) return 'king safety'
  return 'positional / calculation'
}

function difficulty(cpl: number, legalMoveCount: number, motif: string): number {
  let score = 1
  if (cpl >= 200) score += 1
  if (cpl >= 400) score += 1
  if (legalMoveCount >= 25) score += 1
  if (motif === 'positional / calculation') score += 1
  return Math.max(1, Math.min(5, score))
}

export async function stablePuzzleId(gameId: string, ply: number, bestMoveUci: string): Promise<string> {
  return (await sha256Hex(`${gameId}:${ply}:${bestMoveUci}`)).slice(0, 24)
}

export async function extractPuzzles(rows: FeatureRow[]): Promise<PuzzleSeed[]> {
  const seeds: PuzzleSeed[] = []
  for (const row of rows) {
    const quality = text(row.quality).toLowerCase()
    if (!['miss', 'mistake', 'blunder'].includes(quality)) continue
    const bestUci = text(row.best_move_uci)
    const actualUci = text(row.uci)
    const fen = text(row.fen_before)
    if (!bestUci || !actualUci || !fen || bestUci === actualUci) continue
    const board = new Chess(fen)
    if (!isLegalUci(board, bestUci)) continue
    const played = afterMove(fen, actualUci)
    if (played?.isCheckmate()) continue
    const cpl = Math.max(0, Math.trunc(row.cpl))
    const qualityReason = text(row.quality_reason)
    const motif = classifyMotif(fen, bestUci, Math.trunc(row.king_ring_attacks || 0))
    const moveNumber = Math.trunc(row.fullmove_number || Math.floor((row.ply + 1) / 2))
    const san = text(row.san, text(row.uci, 'move'))
    const white = text(row.white)
    const black = text(row.black)
    seeds.push({
      puzzle_id: await stablePuzzleId(text(row.game_id), row.ply, bestUci),
      game_id: text(row.game_id),
      ply: row.ply,
      fen_before: fen,
      color: text(row.color, 'unknown'),
      game_label: white && black ? `${white} vs ${black}` : 'Game',
      move_label: row.color === 'white' ? `${moveNumber}.${san}` : `${moveNumber}...${san}`,
      your_move_san: text(row.san, actualUci),
      your_move_uci: actualUci,
      best_move_san: board.move(parseUci(bestUci)).san,
      best_move_uci: bestUci,
      cpl,
      eval_loss_pawns: displayLossPawns(cpl, qualityReason),
      quality,
      opening: text(row.opening, 'Unknown opening'),
      eco: text(row.eco, 'unknown'),
      game_phase: text(row.game_phase, 'unknown'),
      source_url: text(row.source_url),
      motif,
      difficulty: difficulty(cpl, new Chess(fen).moves().length, motif),
      quality_reason: qualityReason,
    })
  }
  return seeds
}
