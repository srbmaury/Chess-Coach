// Board geometry mirroring the python-chess primitives the Python pipeline uses:
// attacks(square), is_attacked_by(color, square), is_pinned(color, square), and
// king rings. Legal-move generation, SAN, check and mate come from chess.js.
import { Chess } from 'chess.js'

export type Color = 'w' | 'b'
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type Piece = { type: PieceType; color: Color }

// Square index 0 = a1 … 63 = h8, as in python-chess.
export const squareName = (square: number) => `${'abcdefgh'[square & 7]}${(square >> 3) + 1}`
export const squareIndex = (name: string) => (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97)
export const fileOf = (square: number) => square & 7
export const rankOf = (square: number) => square >> 3

export const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]]

export class Board {
  readonly squares: (Piece | null)[]
  readonly turn: Color
  readonly castling: string
  readonly chess: Chess

  constructor(readonly fen: string) {
    this.chess = new Chess(fen)
    const [placement, turn, castling] = fen.split(' ')
    this.turn = turn as Color
    this.castling = castling
    this.squares = new Array(64).fill(null)
    placement.split('/').forEach((row, index) => {
      const rank = 7 - index
      let file = 0
      for (const symbol of row) {
        if (/\d/.test(symbol)) {
          file += Number(symbol)
          continue
        }
        const color: Color = symbol === symbol.toUpperCase() ? 'w' : 'b'
        this.squares[rank * 8 + file] = { type: symbol.toLowerCase() as PieceType, color }
        file += 1
      }
    })
  }

  pieceAt(square: number): Piece | null {
    return this.squares[square]
  }

  pieces(type: PieceType, color: Color): number[] {
    const found: number[] = []
    this.squares.forEach((piece, square) => {
      if (piece && piece.type === type && piece.color === color) found.push(square)
    })
    return found
  }

  king(color: Color): number | null {
    return this.pieces('k', color)[0] ?? null
  }

  private rays(square: number, directions: number[][]): number[] {
    const result: number[] = []
    for (const [df, dr] of directions) {
      let file = fileOf(square) + df
      let rank = rankOf(square) + dr
      while (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
        const target = rank * 8 + file
        result.push(target)
        if (this.squares[target]) break
        file += df
        rank += dr
      }
    }
    return result
  }

  private steps(square: number, offsets: number[][]): number[] {
    const result: number[] = []
    for (const [df, dr] of offsets) {
      const file = fileOf(square) + df
      const rank = rankOf(square) + dr
      if (file >= 0 && file < 8 && rank >= 0 && rank < 8) result.push(rank * 8 + file)
    }
    return result
  }

  /** Squares attacked by the piece on `square` (python-chess `Board.attacks`). */
  attacks(square: number): number[] {
    const piece = this.squares[square]
    if (!piece) return []
    switch (piece.type) {
      case 'p': return this.steps(square, piece.color === 'w' ? [[-1, 1], [1, 1]] : [[-1, -1], [1, -1]])
      case 'n': return this.steps(square, KNIGHT)
      case 'k': return this.steps(square, KING)
      case 'b': return this.rays(square, BISHOP_DIRS)
      case 'r': return this.rays(square, ROOK_DIRS)
      case 'q': return this.rays(square, [...ROOK_DIRS, ...BISHOP_DIRS])
    }
  }

  isAttackedBy(color: Color, square: number): boolean {
    return this.squares.some((piece, from) =>
      piece !== null && piece.color === color && this.attacks(from).includes(square))
  }

  /** King ring squares (python-chess `BB_KING_ATTACKS[king]`). */
  kingRing(square: number): number[] {
    return this.steps(square, KING)
  }

  /** Whether the piece on `square` is absolutely pinned to its own king. */
  isPinned(color: Color, square: number): boolean {
    const king = this.king(color)
    if (king === null || king === square) return false
    const df = Math.sign(fileOf(square) - fileOf(king))
    const dr = Math.sign(rankOf(square) - rankOf(king))
    const fileDelta = Math.abs(fileOf(square) - fileOf(king))
    const rankDelta = Math.abs(rankOf(square) - rankOf(king))
    if (!(fileDelta === 0 || rankDelta === 0 || fileDelta === rankDelta)) return false
    const diagonal = df !== 0 && dr !== 0
    let file = fileOf(king) + df
    let rank = rankOf(king) + dr
    let passedTarget = false
    while (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
      const current = rank * 8 + file
      const piece = this.squares[current]
      if (current === square) {
        passedTarget = true
      } else if (piece) {
        if (!passedTarget || piece.color === color) return false
        return piece.type === 'q' || (diagonal ? piece.type === 'b' : piece.type === 'r')
      }
      file += df
      rank += dr
    }
    return false
  }

  hasCastlingRight(color: Color, side: 'k' | 'q'): boolean {
    const flag = color === 'w' ? side.toUpperCase() : side
    return this.castling.includes(flag)
  }
}

/** A chess.js position rendered as python-chess `Board.fen()` would render it. */
export function pythonFen(chess: Chess): string {
  const fields = chess.fen().split(' ')
  if (fields[3] !== '-' && !chess.moves({ verbose: true }).some((move) => move.flags.includes('e'))) {
    fields[3] = '-'
  }
  return fields.join(' ')
}

export function parseUci(uci: string): { from: string; to: string; promotion?: string } {
  return uci.length > 4
    ? { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }
    : { from: uci.slice(0, 2), to: uci.slice(2, 4) }
}

export function isLegalUci(chess: Chess, uci: string): boolean {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false
  const { from, to, promotion } = parseUci(uci)
  return chess.moves({ verbose: true }).some((move) =>
    move.from === from && move.to === to && (move.promotion ?? undefined) === promotion)
}

/** Play a UCI move on a copy; returns null when the move is illegal. */
export function afterMove(fen: string, uci: string): Chess | null {
  const chess = new Chess(fen)
  if (!isLegalUci(chess, uci)) return null
  chess.move(parseUci(uci))
  return chess
}

export function sanOf(fen: string, uci: string): string {
  const chess = new Chess(fen)
  return chess.move(parseUci(uci)).san
}

export function material(board: Board, color: Color): number {
  return (['p', 'n', 'b', 'r', 'q'] as PieceType[])
    .reduce((total, type) => total + board.pieces(type, color).length * PIECE_VALUES[type], 0)
}
