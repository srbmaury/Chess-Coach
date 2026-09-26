// Feature dataset ported from features.py (feature schema 1).
import { Board, fileOf, PIECE_VALUES, type Color, type PieceType } from './board'
import { gamePositions, type AnalysisRow, type ManifestGame } from './classify'

export type FeatureRow = {
  game_id: string
  game_date: string | null
  ply: number
  fullmove_number: number
  color: 'white' | 'black'
  fen_before: string
  fen_after: string
  san: string
  uci: string
  clock_seconds: number | null
  white: string
  black: string
  source_url: string | null
  eco: string
  opening: string
  best_move_uci: string | null
  eval_before_cp: number
  eval_after_cp: number
  cpl: number
  quality: string
  quality_reason: string
  legal_move_count: number
  in_check: number
  white_material: number
  black_material: number
  material_balance_white: number
  total_non_king_material: number
  non_pawn_non_king_material: number
  white_castling_rights: number
  black_castling_rights: number
  white_queen_present: number
  black_queen_present: number
  white_pawn_islands: number
  black_pawn_islands: number
  white_doubled_pawns: number
  black_doubled_pawns: number
  white_isolated_pawns: number
  black_isolated_pawns: number
  white_king_ring_attacks: number
  black_king_ring_attacks: number
  white_king_castled: number
  black_king_castled: number
  game_phase: string
  time_control_category: string
  user_rating: number | null
  opponent_rating: number | null
  rating_difference: number | null
  material_balance: number
  king_ring_attacks: number
  own_castling_rights: number
  own_doubled_pawns: number
  own_isolated_pawns: number
  own_pawn_islands: number
  engine_eval_before_cp: number
  significant_mistake: number
}

const pawnFiles = (board: Board, color: Color) => board.pieces('p', color).map(fileOf)

function pawnIslands(files: number[]): number {
  const unique = [...new Set(files)].sort((a, b) => a - b)
  if (!unique.length) return 0
  return 1 + unique.slice(1).filter((file, index) => file !== unique[index] + 1).length
}

function doubledPawns(files: number[]): number {
  const counts = new Map<number, number>()
  files.forEach((file) => counts.set(file, (counts.get(file) ?? 0) + 1))
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
}

function isolatedPawns(files: number[]): number {
  const occupied = new Set(files)
  return files.filter((file) => !occupied.has(file - 1) && !occupied.has(file + 1)).length
}

function materialOf(board: Board, color: Color): number {
  return (['p', 'n', 'b', 'r', 'q'] as PieceType[])
    .reduce((total, type) => total + board.pieces(type, color).length * PIECE_VALUES[type], 0)
}

function nonPawnNonKingMaterial(board: Board): number {
  return (['w', 'b'] as Color[]).reduce((total, color) =>
    total + (['n', 'b', 'r', 'q'] as PieceType[])
      .reduce((sum, type) => sum + board.pieces(type, color).length * PIECE_VALUES[type], 0), 0)
}

function kingRingAttacks(board: Board, color: Color): number {
  const king = board.king(color)
  if (king === null) return 0
  const enemy: Color = color === 'w' ? 'b' : 'w'
  return board.kingRing(king).filter((square) => board.isAttackedBy(enemy, square)).length
}

function kingCastled(board: Board, color: Color): number {
  const king = board.king(color)
  const targets = color === 'w' ? [6, 2] : [62, 58]
  return king !== null && targets.includes(king) ? 1 : 0
}

export function extractPositionFeatures(fen: string) {
  const board = new Board(fen)
  const whiteFiles = pawnFiles(board, 'w')
  const blackFiles = pawnFiles(board, 'b')
  const whiteMaterial = materialOf(board, 'w')
  const blackMaterial = materialOf(board, 'b')
  const rights = (color: Color) =>
    Number(board.hasCastlingRight(color, 'k')) + Number(board.hasCastlingRight(color, 'q'))
  return {
    legal_move_count: board.chess.moves().length,
    in_check: Number(board.chess.inCheck()),
    white_material: whiteMaterial,
    black_material: blackMaterial,
    material_balance_white: whiteMaterial - blackMaterial,
    total_non_king_material: whiteMaterial + blackMaterial,
    non_pawn_non_king_material: nonPawnNonKingMaterial(board),
    white_castling_rights: rights('w'),
    black_castling_rights: rights('b'),
    white_queen_present: Number(board.pieces('q', 'w').length > 0),
    black_queen_present: Number(board.pieces('q', 'b').length > 0),
    white_pawn_islands: pawnIslands(whiteFiles),
    black_pawn_islands: pawnIslands(blackFiles),
    white_doubled_pawns: doubledPawns(whiteFiles),
    black_doubled_pawns: doubledPawns(blackFiles),
    white_isolated_pawns: isolatedPawns(whiteFiles),
    black_isolated_pawns: isolatedPawns(blackFiles),
    white_king_ring_attacks: kingRingAttacks(board, 'w'),
    black_king_ring_attacks: kingRingAttacks(board, 'b'),
    white_king_castled: kingCastled(board, 'w'),
    black_king_castled: kingCastled(board, 'b'),
  }
}

export function classifyPhase(fen: string, fullmoveNumber: number): string {
  if (fullmoveNumber <= 12) return 'opening'
  const board = new Board(fen)
  const queens = board.pieces('q', 'w').length + board.pieces('q', 'b').length
  if (queens === 0 && nonPawnNonKingMaterial(board) <= 16) return 'endgame'
  return 'middlegame'
}

export function timeControlCategory(value: string | null): string {
  if (value === null) return 'unknown'
  const text = value.trim()
  if (!text) return 'unknown'
  if (text.includes('/')) return 'daily'
  const head = text.split('+', 1)[0].trim()
  // Python float() accepts surrounding whitespace, signs, and exponents.
  const seconds = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(head) ? Number(head) : Number.NaN
  if (Number.isNaN(seconds)) return 'unknown'
  if (seconds < 180) return 'bullet'
  if (seconds < 600) return 'blitz'
  if (seconds < 3600) return 'rapid'
  return 'classical'
}

const SIGNIFICANT = new Set(['miss', 'mistake', 'blunder'])

/** Join analysis rows to their games and positions, ordered like the Python frame. */
export function buildFeatureDataset(
  games: ManifestGame[],
  analysis: Map<string, AnalysisRow[]>,
): FeatureRow[] {
  const rows: FeatureRow[] = []
  for (const game of games) {
    const analyzed = new Map((analysis.get(game.game_id) ?? []).map((row) => [row.ply, row]))
    for (const position of gamePositions(game)) {
      if (!position.isUserMove) continue
      const result = analyzed.get(position.ply)
      if (!result) continue
      const features = extractPositionFeatures(position.fenBefore)
      const white = position.color === 'white'
      const userRating = white ? game.white_rating : game.black_rating
      const opponentRating = white ? game.black_rating : game.white_rating
      rows.push({
        game_id: game.game_id,
        game_date: game.game_date,
        ply: position.ply,
        fullmove_number: position.fullmoveNumber,
        color: position.color,
        fen_before: position.fenBefore,
        fen_after: position.fenAfter,
        san: position.san,
        uci: position.uci,
        clock_seconds: position.clockSeconds,
        white: game.white,
        black: game.black,
        source_url: game.source_url,
        eco: game.eco ?? 'unknown',
        opening: game.opening ?? 'unknown',
        best_move_uci: result.best_move_uci,
        eval_before_cp: result.eval_before_cp,
        eval_after_cp: result.eval_after_cp,
        cpl: result.cpl,
        quality: result.quality,
        quality_reason: result.quality_reason,
        ...features,
        game_phase: classifyPhase(position.fenBefore, position.fullmoveNumber),
        time_control_category: timeControlCategory(game.time_control),
        user_rating: userRating,
        opponent_rating: opponentRating,
        rating_difference: userRating !== null && opponentRating !== null ? userRating - opponentRating : null,
        material_balance: white ? features.material_balance_white : 0 - features.material_balance_white,
        king_ring_attacks: white ? features.white_king_ring_attacks : features.black_king_ring_attacks,
        own_castling_rights: white ? features.white_castling_rights : features.black_castling_rights,
        own_doubled_pawns: white ? features.white_doubled_pawns : features.black_doubled_pawns,
        own_isolated_pawns: white ? features.white_isolated_pawns : features.black_isolated_pawns,
        own_pawn_islands: white ? features.white_pawn_islands : features.black_pawn_islands,
        engine_eval_before_cp: result.eval_before_cp,
        significant_mistake: SIGNIFICANT.has(result.quality) ? 1 : 0,
      })
    }
  }
  // pandas sort_values(["game_date", "game_id", "ply"], na_position="last") is stable.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row.game_date
      const right = b.row.game_date
      if (left !== right) {
        if (left === null) return 1
        if (right === null) return -1
        return left < right ? -1 : 1
      }
      if (a.row.game_id !== b.row.game_id) return a.row.game_id < b.row.game_id ? -1 : 1
      return a.row.ply - b.row.ply || a.index - b.index
    })
    .map(({ row }) => row)
}
