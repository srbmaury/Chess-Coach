// Adaptive practice, ported from adaptive_practice.py / adaptive_hint.py to run on the
// browser's Stockfish. The drill continues past the first move: the engine replies,
// and the player keeps finding strong moves until the idea is converted.
//
// Sessions live in memory; the server only records the finished drill's outcome
// (spaced-repetition review and drill metrics) through `complete`.
import { Chess } from 'chess.js'

import { isLegalUci, parseUci, pythonFen, type Color } from '../analysis/board'
import { pov, scoreValue, type EngineLine, type MoveEngine } from '../analysis/classify'

export const ACCEPTANCE_TOLERANCE_CP = 30
export const MAX_USER_DECISIONS = 4
export const MAX_PLIES = 8

export class AdaptiveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export type AdaptivePuzzle = { puzzle_id: string; fen: string; orientation: string; best_move_uci: string }
export type AdaptiveReview = { next_interval_days: number; next_review_at: string; consecutive_correct: number; mastered: boolean }
export type DrillOutcome = {
  succeeded: boolean
  answer: string
  user_moves_accepted: number
  current_ply: number
  continuation_attempts: number
  continuation_correct: number
}

type Step = { step_index: number; side: 'user' | 'engine'; fen_before: string; move_uci: string; move_san: string; accepted: boolean }
type Session = {
  session_id: string
  puzzle: AdaptivePuzzle
  status: 'active' | 'succeeded' | 'failed' | 'abandoned'
  starting_fen: string
  current_fen: string
  user_color: Color
  user_moves_attempted: number
  user_moves_accepted: number
  current_ply: number
  max_eval_loss_cp: number
  steps: Step[]
  review: AdaptiveReview | null
  expected_user_uci: string | null
  expected_best_eval_cp: number | null
  expected_winning_mate: boolean | null
}

type Analysis = { line: EngineLine; turn: Color }

export class AdaptivePractice {
  private readonly sessions = new Map<string, Session>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly engine: () => MoveEngine,
    private readonly complete: (puzzleId: string, outcome: DrillOutcome) => Promise<AdaptiveReview>,
    private readonly newId: () => string = () => crypto.randomUUID().replaceAll('-', ''),
  ) {}

  /** Serialize operations so one drill's moves never interleave. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async analyse(fen: string): Promise<Analysis> {
    let lines: EngineLine[]
    try {
      lines = await this.engine().search(fen, 1)
    } catch {
      throw new AdaptiveError('Stockfish stopped during adaptive practice', 503)
    }
    if (!lines.length) throw new AdaptiveError('Stockfish returned no usable score', 503)
    return { line: lines[0], turn: fen.split(' ')[1] as Color }
  }

  private evalFor(analysis: Analysis, user: Color): number {
    return scoreValue(pov(analysis.line.score, analysis.turn, user))
  }

  private winningMate(analysis: Analysis, user: Color): boolean {
    const score = pov(analysis.line.score, analysis.turn, user)
    return score.kind === 'mate' && score.moves > 0
  }

  private firstPvMove(analysis: Analysis, fen: string): string | null {
    const move = analysis.line.pv[0]
    return move && isLegalUci(new Chess(fen), move) ? move : null
  }

  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AdaptiveError(`Unknown adaptive session: ${sessionId}`, 404)
    return session
  }

  // Views matching the adaptive API responses ------------------------------------------

  private startView(session: Session) {
    return {
      session_id: session.session_id,
      puzzle_id: session.puzzle.puzzle_id,
      status: session.status,
      current_fen: session.current_fen,
      orientation: session.puzzle.orientation,
      user_moves_attempted: session.user_moves_attempted,
      user_moves_accepted: session.user_moves_accepted,
      current_ply: session.current_ply,
      max_eval_loss_cp: session.max_eval_loss_cp,
      max_user_decisions: MAX_USER_DECISIONS,
      steps: session.steps.filter((step) => step.accepted).map(({ step_index, side, move_uci, move_san, accepted }) =>
        ({ step_index, side, move_uci, move_san, accepted })),
      review: session.review,
    }
  }

  private moveView(session: Session, move: {
    accepted: boolean | null; move_uci?: string | null; move_san?: string | null; eval_loss_cp?: number | null
    engine_reply_uci?: string | null; engine_reply_san?: string | null
  }) {
    return {
      session_id: session.session_id,
      puzzle_id: session.puzzle.puzzle_id,
      status: session.status,
      accepted: move.accepted,
      move_uci: move.move_uci ?? null,
      move_san: move.move_san ?? null,
      eval_loss_cp: move.eval_loss_cp ?? null,
      engine_reply_uci: move.engine_reply_uci ?? null,
      engine_reply_san: move.engine_reply_san ?? null,
      current_fen: session.current_fen,
      user_moves_attempted: session.user_moves_attempted,
      user_moves_accepted: session.user_moves_accepted,
      current_ply: session.current_ply,
      max_eval_loss_cp: session.max_eval_loss_cp,
      review: session.review,
    }
  }

  // Operations ---------------------------------------------------------------------------

  start(puzzle: AdaptivePuzzle) {
    return this.run(async () => {
      const existing = [...this.sessions.values()].find((item) => item.puzzle.puzzle_id === puzzle.puzzle_id && item.status === 'active')
      if (existing) return this.startView(existing)
      const fen = pythonFen(new Chess(puzzle.fen))
      const session: Session = {
        session_id: this.newId(),
        puzzle,
        status: 'active',
        starting_fen: fen,
        current_fen: fen,
        user_color: puzzle.orientation === 'black' ? 'b' : 'w',
        user_moves_attempted: 0,
        user_moves_accepted: 0,
        current_ply: 0,
        max_eval_loss_cp: 0,
        steps: [],
        review: null,
        expected_user_uci: puzzle.best_move_uci,
        expected_best_eval_cp: null,
        expected_winning_mate: null,
      }
      this.sessions.set(session.session_id, session)
      return this.startView(session)
    })
  }

  /** The move to beat in the current position and its evaluation (engine baseline). */
  private async baseline(session: Session): Promise<{ expected: string | null; bestEval: number; bestWinningMate: boolean }> {
    const fen = session.current_fen
    const board = new Chess(fen)
    let expected = session.expected_user_uci
    if (expected && session.expected_best_eval_cp !== null && isLegalUci(board, expected)) {
      return { expected, bestEval: session.expected_best_eval_cp, bestWinningMate: Boolean(session.expected_winning_mate) }
    }
    const info = await this.analyse(fen)
    const bestEval = this.evalFor(info, session.user_color)
    const best = this.firstPvMove(info, fen)
    if (expected && !isLegalUci(board, expected)) expected = null
    if (!expected) expected = best ?? session.puzzle.best_move_uci
    session.expected_user_uci = expected
    session.expected_best_eval_cp = bestEval
    session.expected_winning_mate = this.winningMate(info, session.user_color)
    return { expected, bestEval, bestWinningMate: session.expected_winning_mate }
  }

  private advance(session: Session, update: {
    fen: string; steps: Omit<Step, 'step_index'>[]; attempted: number; accepted: number; ply: number; loss: number
  }): void {
    let index = session.steps.length
    for (const step of update.steps) session.steps.push({ ...step, step_index: index++ })
    session.current_fen = update.fen
    session.user_moves_attempted += update.attempted
    session.user_moves_accepted += update.accepted
    session.current_ply = update.ply
    session.max_eval_loss_cp = Math.max(session.max_eval_loss_cp, update.loss)
  }

  private async finish(session: Session, fallbackAnswer: string): Promise<void> {
    const succeeded = session.user_moves_attempted === session.user_moves_accepted
    const userSteps = session.steps.filter((step) => step.side === 'user')
    const continuation = userSteps.filter((step) => step.fen_before !== session.starting_fen)
    session.review = await this.complete(session.puzzle.puzzle_id, {
      succeeded,
      answer: userSteps[0]?.move_uci ?? fallbackAnswer,
      user_moves_accepted: session.user_moves_accepted,
      current_ply: session.current_ply,
      continuation_attempts: continuation.length,
      continuation_correct: continuation.filter((step) => step.accepted).length,
    })
    session.status = succeeded ? 'succeeded' : 'failed'
  }

  move(sessionId: string, moveUci: string) {
    return this.run(async () => {
      const session = this.session(sessionId)
      if (session.status !== 'active') return this.moveView(session, { accepted: null })
      const fen = session.current_fen
      const board = new Chess(fen)
      if (board.turn() !== session.user_color) throw new AdaptiveError("Adaptive session is not at the user's turn", 409)
      const uci = moveUci.toLowerCase()
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new AdaptiveError('Move must be legal UCI notation', 422)
      if (!isLegalUci(board, uci)) throw new AdaptiveError('Submitted move is not legal in this position', 422)

      const { expected, bestEval, bestWinningMate } = await this.baseline(session)
      const played = board.move(parseUci(uci))
      const afterUser = pythonFen(board)
      const exact = expected === uci
      let candidate: Analysis | null = null
      let loss = 0
      let accepted = exact
      if (!exact) {
        candidate = await this.analyse(afterUser)
        const candidateEval = this.evalFor(candidate, session.user_color)
        if (bestWinningMate) {
          accepted = this.winningMate(candidate, session.user_color)
          loss = accepted ? 0 : ACCEPTANCE_TOLERANCE_CP + 1
        } else {
          loss = Math.max(0, bestEval - candidateEval)
          accepted = loss <= ACCEPTANCE_TOLERANCE_CP
        }
      }
      const userStep = { side: 'user' as const, fen_before: fen, move_uci: uci, move_san: played.san, accepted }
      const acceptedCount = session.user_moves_accepted + Number(accepted)
      const plyAfterUser = session.current_ply + 1

      if (!accepted) {
        this.advance(session, { fen, steps: [userStep], attempted: 1, accepted: 0, ply: session.current_ply, loss })
        return this.moveView(session, { accepted: false, move_uci: uci, move_san: played.san, eval_loss_cp: loss })
      }

      const afterUserBoard = new Chess(afterUser)
      if (afterUserBoard.isGameOver() || acceptedCount >= MAX_USER_DECISIONS || plyAfterUser >= MAX_PLIES) {
        this.advance(session, { fen: afterUser, steps: [userStep], attempted: 1, accepted: 1, ply: plyAfterUser, loss })
        await this.finish(session, uci)
        return this.moveView(session, { accepted: true, move_uci: uci, move_san: played.san, eval_loss_cp: loss })
      }

      const replyInfo = candidate ?? await this.analyse(afterUser)
      const reply = this.firstPvMove(replyInfo, afterUser)
      if (!reply) {
        this.advance(session, { fen: afterUser, steps: [userStep], attempted: 1, accepted: 1, ply: plyAfterUser, loss })
        await this.finish(session, uci)
        return this.moveView(session, { accepted: true, move_uci: uci, move_san: played.san, eval_loss_cp: loss })
      }
      const replyMove = afterUserBoard.move(parseUci(reply))
      const afterReply = pythonFen(afterUserBoard)
      const replyEval = this.evalFor(replyInfo, session.user_color)
      const engineStep = { side: 'engine' as const, fen_before: afterUser, move_uci: reply, move_san: replyMove.san, accepted: true }
      const plyAfterReply = plyAfterUser + 1

      const nextUser = replyInfo.line.pv[1]
      session.expected_user_uci = nextUser && isLegalUci(new Chess(afterReply), nextUser) ? nextUser : null
      session.expected_best_eval_cp = replyEval
      session.expected_winning_mate = this.winningMate(replyInfo, session.user_color)

      let shouldFinish = afterUserBoard.isGameOver() || plyAfterReply >= MAX_PLIES
      if (!shouldFinish && acceptedCount >= 2) {
        const current = await this.analyse(afterReply)
        const currentEval = this.evalFor(current, session.user_color)
        const currentMove = this.firstPvMove(current, afterReply)
        const currentWinningMate = this.winningMate(current, session.user_color)
        const stable = Math.abs(currentEval - bestEval) <= ACCEPTANCE_TOLERANCE_CP
        shouldFinish = !currentWinningMate && !isForcing(afterReply, currentMove) && stable
        session.expected_user_uci = currentMove
        session.expected_best_eval_cp = currentEval
        session.expected_winning_mate = currentWinningMate
      }
      this.advance(session, { fen: afterReply, steps: [userStep, engineStep], attempted: 1, accepted: 1, ply: plyAfterReply, loss })
      if (shouldFinish) await this.finish(session, uci)
      return this.moveView(session, {
        accepted: true, move_uci: uci, move_san: played.san, eval_loss_cp: loss,
        engine_reply_uci: reply, engine_reply_san: replyMove.san,
      })
    })
  }

  /** Reveal the best move; asking for help makes a perfect drill count as assisted. */
  hint(sessionId: string) {
    return this.run(async () => {
      const session = this.session(sessionId)
      if (session.status !== 'active') throw new AdaptiveError('Adaptive session is not active', 409)
      const board = new Chess(session.current_fen)
      if (board.turn() !== session.user_color) throw new AdaptiveError("Adaptive session is not at the user's turn", 409)
      const { expected } = await this.baseline(session)
      if (!expected || !isLegalUci(board, expected)) throw new AdaptiveError('Stockfish returned no usable best move', 503)
      if (session.user_moves_attempted === session.user_moves_accepted) session.user_moves_attempted += 1
      return {
        session_id: session.session_id,
        puzzle_id: session.puzzle.puzzle_id,
        status: session.status,
        move_uci: expected,
        move_san: board.move(parseUci(expected)).san,
        current_fen: session.current_fen,
        user_moves_attempted: session.user_moves_attempted,
        user_moves_accepted: session.user_moves_accepted,
        current_ply: session.current_ply,
      }
    })
  }

  abandon(sessionId: string) {
    return this.run(async () => {
      const session = this.session(sessionId)
      if (session.status === 'active') session.status = 'abandoned'
      return this.startView(session)
    })
  }
}

function isForcing(fen: string, move: string | null): boolean {
  if (!move) return false
  const board = new Chess(fen)
  if (!isLegalUci(board, move)) return false
  const played = board.move(parseUci(move))
  return board.inCheck() || played.flags.includes('c') || played.flags.includes('e') || Boolean(played.promotion)
}
