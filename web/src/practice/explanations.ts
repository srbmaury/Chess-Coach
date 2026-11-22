// Puzzle explanations, ported from explanations.py to run on the browser's Stockfish:
// the idea behind the best move, the engine's best line, and why the game move was
// worse. Board facts need no engine; the best line comes from one engine search.
import { Chess } from 'chess.js'

import { Board, PIECE_VALUES, isLegalUci, parseUci, pythonFen, squareIndex, squareName, type PieceType } from '../analysis/board'
import type { MoveEngine } from '../analysis/classify'
import { formatFixed, pyTitle } from '../analysis/pyformat'

export type ExplainablePuzzle = {
  puzzle_id: string
  fen: string
  best_move_uci: string
  best_move_san: string
  your_move_uci: string
  your_move_san: string
  motif: string
  /** Pawns lost; null when the loss was mate-related. */
  evaluation_loss_pawns: number | null
}

export type Explanation = {
  idea: string
  why: string
  best_line: string[]
  why_your_move_was_worse: string
  engine_grounded: boolean
  depth: number
  cached: boolean
}

const PIECE_NAMES: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const BEST_CONTINUATION: [string, string] = [
  'Best continuation',
  'Stockfish evaluates this move as the strongest continuation in the position.',
]

function bestMoveFacts(puzzle: ExplainablePuzzle): [string, string] {
  const board = new Chess(puzzle.fen)
  if (!isLegalUci(board, puzzle.best_move_uci)) return BEST_CONTINUATION
  const move = board.move(parseUci(puzzle.best_move_uci))
  const capture = move.flags.includes('c') || move.flags.includes('e')
  const check = board.inCheck()
  if (board.isCheckmate()) return ['Checkmate', 'This move ends the game immediately with checkmate.']
  if (check && capture) {
    return ['Forcing check', 'This move captures with check, forcing the opponent to answer the king threat before doing anything else.']
  }
  if (check) return ['Forcing check', 'This move gives check, forcing an immediate king response and keeping the initiative.']
  if (capture) {
    return ['Tactical capture', 'This move makes the strongest capture in the position and leads to the best concrete continuation.']
  }
  if (move.promotion) return ['Promotion', 'This move promotes a pawn and creates the strongest immediate material threat.']
  if (puzzle.motif && puzzle.motif !== 'positional / calculation') {
    return [pyTitle(puzzle.motif.split('_').join(' ')), 'Stockfish confirms this tactical idea as the strongest continuation in the position.']
  }
  return BEST_CONTINUATION
}

/** A move that leaves the moved piece undefended and capturable for free. */
function hangingPieceNote(fen: string, moveUci: string): string | null {
  const chess = new Chess(fen)
  if (!isLegalUci(chess, moveUci)) return null
  const mover = chess.turn()
  chess.move(parseUci(moveUci))
  const after = new Board(pythonFen(chess))
  const dest = squareIndex(moveUci.slice(2, 4))
  const piece = after.pieceAt(dest)
  if (!piece || piece.type === 'k') return null
  const attackers = (color: 'w' | 'b') => after.squares.flatMap((candidate, square) =>
    candidate && candidate.color === color && after.attacks(square).includes(dest) ? [square] : [])
  if (attackers(mover).length) return null
  const enemy = mover === 'w' ? 'b' : 'w'
  const sorted = attackers(enemy).sort((a, b) => PIECE_VALUES[after.pieceAt(a)!.type] - PIECE_VALUES[after.pieceAt(b)!.type])
  for (const square of sorted) {
    const attacker = after.pieceAt(square)!
    const rank = Math.floor(dest / 8)
    const capture = `${squareName(square)}${squareName(dest)}${attacker.type === 'p' && (rank === 0 || rank === 7) ? 'q' : ''}`
    if (isLegalUci(chess, capture)) {
      const san = chess.move(parseUci(capture)).san
      return `leaves the ${PIECE_NAMES[piece.type]} on ${squareName(dest)} completely undefended - ${san} simply wins it for free`
    }
  }
  return null
}

function whyWorse(puzzle: ExplainablePuzzle): string {
  const note = hangingPieceNote(puzzle.fen, puzzle.your_move_uci)
  const loss = puzzle.evaluation_loss_pawns
  if (loss === null || loss >= 50) {
    return note
      ? `Your game move ${puzzle.your_move_san} ${note}, causing a decisive, mate-level evaluation swing.`
      : `Your game move ${puzzle.your_move_san} missed this continuation and caused a decisive, mate-level evaluation swing.`
  }
  return note
    ? `Your game move ${puzzle.your_move_san} ${note}, losing about ${formatFixed(loss, 2)} pawns of evaluation compared with the best move.`
    : `Your game move ${puzzle.your_move_san} missed this continuation and lost about ${formatFixed(loss, 2)} pawns of evaluation compared with the best move.`
}

function sanLine(fen: string, moves: string[], limit = 6): string[] {
  const chess = new Chess(fen)
  const line: string[] = []
  for (const move of moves.slice(0, limit)) {
    if (!isLegalUci(chess, move)) break
    line.push(chess.move(parseUci(move)).san)
  }
  return line
}

export class Explainer {
  private readonly cache = new Map<string, Explanation>()

  constructor(private readonly engine: () => MoveEngine, private readonly depth: number) {}

  async explain(puzzle: ExplainablePuzzle): Promise<Explanation> {
    const key = `${puzzle.puzzle_id}|${puzzle.fen}|${puzzle.best_move_uci}|${puzzle.your_move_uci}`
    const cached = this.cache.get(key)
    if (cached) return { ...cached, cached: true }
    const [idea, reason] = bestMoveFacts(puzzle)
    const worse = whyWorse(puzzle)
    try {
      const [line] = await this.engine().search(puzzle.fen, 1)
      const pv = line?.pv ?? []
      if (pv.length && pv[0] !== puzzle.best_move_uci) {
        const board = new Chess(puzzle.fen)
        const preferred = isLegalUci(board, pv[0]) ? board.move(parseUci(pv[0])).san : pv[0]
        return {
          idea: 'Analysis changed',
          why: `Stockfish at depth ${this.depth} now prefers ${preferred} rather than the stored best move `
            + `${puzzle.best_move_san}. Run the analysis again from the Pipeline page before relying on an `
            + `engine-grounded explanation. Board-only note: ${reason}`,
          best_line: [puzzle.best_move_san],
          why_your_move_was_worse: worse,
          engine_grounded: false,
          depth: this.depth,
          cached: false,
        }
      }
      const line6 = sanLine(puzzle.fen, pv)
      const payload: Explanation = {
        idea,
        why: reason,
        best_line: line6.length ? line6 : [puzzle.best_move_san],
        why_your_move_was_worse: worse,
        engine_grounded: true,
        depth: this.depth,
        cached: false,
      }
      this.cache.set(key, payload)
      return payload
    } catch {
      return {
        idea,
        why: `Stockfish is unavailable, so this explanation uses only the board position. ${reason}`,
        best_line: [puzzle.best_move_san],
        why_your_move_was_worse: worse,
        engine_grounded: false,
        depth: this.depth,
        cached: false,
      }
    }
  }
}
