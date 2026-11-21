import { useCallback, useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { parseUci } from '../analysis/board'
import { requestJson } from '../apiTransport'
import { ErrorBox, Heading } from '../pageControls'
import { useClickToMove } from '../useClickToMove'

export type PracticePuzzle = { puzzle_id: string; fen: string; orientation: string; game: string; move: string; opening: string; eco: string; phase: string; motif: string; difficulty: number; source_url?: string | null }
type Attempt = { correct: boolean; best_move_san: string; best_move_uci: string; your_game_move: string; evaluation_loss_pawns: number | null; quality?: string; quality_reason?: string; next_interval_days: number; next_review_at: string; source_url?: string | null }
type Explanation = { idea: string; why: string; best_line: string[]; why_your_move_was_worse: string; engine_grounded: boolean; depth: number; cached: boolean }
type AdaptiveReview = { next_interval_days: number; next_review_at: string; consecutive_correct: number; mastered: boolean }
type AdaptiveSafeStep = { step_index: number; side: string; move_uci: string; move_san: string; accepted: boolean }
type AdaptiveSession = {
  session_id: string
  puzzle_id: string
  status: string
  current_fen: string
  orientation: string
  user_moves_attempted: number
  user_moves_accepted: number
  current_ply: number
  max_eval_loss_cp: number
  max_user_decisions: number
  steps: AdaptiveSafeStep[]
  review: AdaptiveReview | null
}
type AdaptiveMoveResult = {
  session_id: string
  puzzle_id: string
  status: string
  accepted: boolean | null
  move_uci?: string | null
  move_san?: string | null
  eval_loss_cp?: number | null
  engine_reply_uci?: string | null
  engine_reply_san?: string | null
  current_fen: string
  user_moves_attempted: number
  user_moves_accepted: number
  current_ply: number
  max_eval_loss_cp: number
  review: AdaptiveReview | null
}
type AdaptiveHint = {
  session_id: string
  puzzle_id: string
  status: string
  move_uci: string
  move_san: string
  current_fen: string
  user_moves_attempted: number
  user_moves_accepted: number
  current_ply: number
}
type AdaptiveHistoryEntry = { fen: string; step: AdaptiveSafeStep | null }
type PracticeMode = 'adaptive' | 'quick'

const api = {
  nextPuzzle: () => requestJson<{ puzzle: PracticePuzzle | null }>('/api/practice/next'),
  attempt: (id: string, move_uci: string) => requestJson<Attempt>(`/api/practice/${id}/attempt`, { method: 'POST', body: JSON.stringify({ move_uci }) }),
  explanation: (id: string) => requestJson<Explanation>(`/api/practice/${id}/explanation`),
  skip: (id: string) => requestJson<{ skipped: boolean }>(`/api/practice/${id}/skip`, { method: 'POST' }),
  adaptiveStart: (id: string) => requestJson<AdaptiveSession>(`/api/practice/${id}/adaptive/start`, { method: 'POST' }),
  adaptiveMove: (sessionId: string, move_uci: string) => requestJson<AdaptiveMoveResult>(`/api/practice/adaptive/${sessionId}/move`, { method: 'POST', body: JSON.stringify({ move_uci }) }),
  adaptiveHint: (sessionId: string) => requestJson<AdaptiveHint>(`/api/practice/adaptive/${sessionId}/hint`, { method: 'POST' }),
  adaptiveAbandon: (sessionId: string) => requestJson<AdaptiveSession>(`/api/practice/adaptive/${sessionId}/abandon`, { method: 'POST' }),
}

const titleCaseLabel = (value: string) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : ''
const ADAPTIVE_ENGINE_REPLY_DELAY_MS = 350
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function formatMoveLine(startFen: string, sanMoves: string[]): string {
  const parts = startFen.split(' ')
  let turn = parts[1] === 'b' ? 'b' : 'w'
  let moveNumber = Number(parts[5]) || 1
  const tokens = sanMoves.map((san, index) => {
    const token = turn === 'w' ? `${moveNumber}.${san}` : index === 0 ? `${moveNumber}...${san}` : san
    if (turn === 'b') {
      moveNumber += 1
      turn = 'w'
    } else {
      turn = 'b'
    }
    return token
  })
  return tokens.join(' ')
}

function fenAfterUciMove(fen: string, moveUci: string): string | null {
  try {
    const board = new Chess(fen)
    const played = board.move(parseUci(moveUci))
    return played ? board.fen() : null
  } catch {
    return null
  }
}

// react-chessboard animates castling as a two-phase, uncancelled setTimeout
// (king first, rook ~animationDurationInMs later). If we swap the preview
// position back out before that timer fires, it overwrites the revert with
// the castled position. Only castling needs the extra settle delay below.
function isCastleUciMove(fen: string, moveUci: string): boolean {
  try {
    const board = new Chess(fen)
    const played = board.move(parseUci(moveUci))
    return played != null && (played.flags.includes('k') || played.flags.includes('q'))
  } catch {
    return false
  }
}

function buildAdaptiveHistory(startFen: string, steps: AdaptiveSafeStep[]): AdaptiveHistoryEntry[] {
  const history: AdaptiveHistoryEntry[] = [{ fen: startFen, step: null }]
  let board: Chess
  try {
    board = new Chess(startFen)
  } catch {
    return history
  }
  for (const step of steps.filter((candidate) => candidate.accepted)) {
    const move = step.move_uci
    try {
      const played = board.move(parseUci(move))
      if (!played) break
      history.push({ fen: board.fen(), step })
    } catch {
      break
    }
  }
  return history
}

export default function PracticePage() {
  const [mode, setMode] = useState<PracticeMode>('adaptive')
  const modeRef = useRef<PracticeMode>('adaptive')
  const [puzzle, setPuzzle] = useState<PracticePuzzle | null | undefined>(undefined)
  const [feedback, setFeedback] = useState<Attempt | null>(null)
  const [adaptiveStartStatus, setAdaptiveStartStatus] = useState<'idle' | 'starting' | 'failed'>('idle')
  const [adaptive, setAdaptive] = useState<AdaptiveSession | null>(null)
  const [lastAdaptiveMove, setLastAdaptiveMove] = useState<AdaptiveMoveResult | null>(null)
  const [adaptiveHint, setAdaptiveHint] = useState<AdaptiveHint | null>(null)
  const [hinting, setHinting] = useState(false)
  const [historyPly, setHistoryPly] = useState<number | null>(null)
  const [pendingAdaptiveFen, setPendingAdaptiveFen] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [explanationError, setExplanationError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { modeRef.current = mode }, [mode])

  const startAdaptiveDrill = useCallback(async (puzzleId: string) => {
    setAdaptiveStartStatus('starting')
    setError('')
    try {
      setAdaptive(await api.adaptiveStart(puzzleId))
      setAdaptiveStartStatus('idle')
    } catch (x) {
      setAdaptiveStartStatus('failed')
      setError((x as Error).message)
    }
  }, [])

  const load = useCallback(async () => {
    setFeedback(null)
    setAdaptive(null)
    setAdaptiveStartStatus('idle')
    setLastAdaptiveMove(null)
    setAdaptiveHint(null)
    setHinting(false)
    setHistoryPly(null)
    setPendingAdaptiveFen(null)
    setExplanation(null)
    setExplaining(false)
    setExplanationError('')
    setSubmitting(false)
    setError('')
    setPuzzle(undefined)
    try {
      const result = await api.nextPuzzle()
      setPuzzle(result.puzzle)
      if (result.puzzle && modeRef.current === 'adaptive') {
        await startAdaptiveDrill(result.puzzle.puzzle_id)
      }
    } catch (x) {
      setError((x as Error).message)
    }
  }, [startAdaptiveDrill])

  useEffect(() => { void load() }, [load])

  const adaptiveTerminal = adaptive != null && adaptive.status !== 'active'
  const finished = feedback != null || adaptiveTerminal
  const history = puzzle && adaptive ? buildAdaptiveHistory(puzzle.fen, adaptive.steps) : []
  const liveHistoryPly = Math.max(0, history.length - 1)
  const requestedHistoryPly = historyPly == null ? liveHistoryPly : Math.min(Math.max(historyPly, 0), liveHistoryPly)
  const reviewingHistory = mode === 'adaptive' && adaptive != null && historyPly != null && requestedHistoryPly < liveHistoryPly
  const viewedHistoryPly = reviewingHistory ? requestedHistoryPly : liveHistoryPly
  const boardFen = mode === 'adaptive' && adaptive
    ? (reviewingHistory ? history[viewedHistoryPly]?.fen ?? adaptive.current_fen : pendingAdaptiveFen ?? adaptive.current_fen)
    : puzzle?.fen

  async function submitMove(moveUci: string) {
    if (!puzzle || submitting || finished || reviewingHistory) return
    setSubmitting(true)
    setError('')
    try {
      if (mode === 'quick') {
        setFeedback(await api.attempt(puzzle.puzzle_id, moveUci))
      } else {
        let session = adaptive
        if (!session) {
          session = await api.adaptiveStart(puzzle.puzzle_id)
          setAdaptive(session)
        }
        const previewFen = fenAfterUciMove(session.current_fen, moveUci)
        const isCastle = previewFen ? isCastleUciMove(session.current_fen, moveUci) : false
        const replyDelay = previewFen ? wait(ADAPTIVE_ENGINE_REPLY_DELAY_MS) : null
        if (previewFen) {
          setPendingAdaptiveFen(previewFen)
        }
        setLastAdaptiveMove(null)
        const result = await api.adaptiveMove(session.session_id, moveUci)
        if (replyDelay && (result.accepted === true ? result.engine_reply_uci : isCastle)) {
          await replyDelay
        }
        setLastAdaptiveMove(result)
        if (adaptiveHint && result.current_fen !== adaptiveHint.current_fen) {
          setAdaptiveHint(null)
        }
        setAdaptive((previous) => ({
          session_id: result.session_id,
          puzzle_id: result.puzzle_id,
          status: result.status,
          current_fen: result.current_fen,
          orientation: previous?.orientation ?? puzzle.orientation,
          user_moves_attempted: result.user_moves_attempted,
          user_moves_accepted: result.user_moves_accepted,
          current_ply: result.current_ply,
          max_eval_loss_cp: result.max_eval_loss_cp,
          max_user_decisions: previous?.max_user_decisions ?? 4,
          steps: appendAdaptiveSteps(previous?.steps ?? [], result),
          review: result.review,
        }))
      }
    } catch (x) {
      setError((x as Error).message)
    } finally {
      setPendingAdaptiveFen(null)
      setSubmitting(false)
    }
  }

  async function explainBestMove() {
    if (!puzzle || !finished || explaining || explanation) return
    setExplaining(true)
    setExplanationError('')
    try {
      setExplanation(await api.explanation(puzzle.puzzle_id))
    } catch (x) {
      setExplanationError((x as Error).message)
    } finally {
      setExplaining(false)
    }
  }

  async function changeMode(next: PracticeMode) {
    if (next === mode || submitting || finished || adaptiveStartStatus === 'starting') return
    setError('')
    try {
      if (mode === 'adaptive' && adaptive?.status === 'active') {
        await api.adaptiveAbandon(adaptive.session_id)
      }
      modeRef.current = next
      setMode(next)
      setFeedback(null)
      setLastAdaptiveMove(null)
      setAdaptiveHint(null)
      setHinting(false)
      setHistoryPly(null)
      setPendingAdaptiveFen(null)
      setExplanation(null)
      setExplanationError('')
      if (next === 'adaptive' && puzzle) {
        await startAdaptiveDrill(puzzle.puzzle_id)
      } else {
        setAdaptive(null)
        setAdaptiveStartStatus('idle')
      }
    } catch (x) {
      setError((x as Error).message)
    }
  }

  function onDrop(sourceSquare: string, targetSquare: string | null) {
    if (!puzzle || submitting || finished || reviewingHistory || !targetSquare || !boardFen) return false
    let moveUci = `${sourceSquare}${targetSquare}`
    try {
      const position = new Chess(boardFen)
      const piece = position.get(sourceSquare as never)
      if (piece?.type === 'p' && (targetSquare.endsWith('1') || targetSquare.endsWith('8'))) {
        moveUci += 'q'
      }
    } catch {
      // The backend remains authoritative; submit the basic UCI move if local parsing fails.
    }
    void submitMove(moveUci)
    return true
  }

  async function showNextBestMove() {
    if (!adaptive || adaptive.status !== 'active' || submitting || hinting || reviewingHistory) return
    if (adaptiveHint?.current_fen === adaptive.current_fen) return
    setHinting(true)
    setError('')
    try {
      const hint = await api.adaptiveHint(adaptive.session_id)
      setAdaptiveHint(hint)
      setAdaptive((previous) => previous ? {
        ...previous,
        status: hint.status,
        current_fen: hint.current_fen,
        user_moves_attempted: hint.user_moves_attempted,
        user_moves_accepted: hint.user_moves_accepted,
        current_ply: hint.current_ply,
      } : previous)
    } catch (x) {
      setError((x as Error).message)
    } finally {
      setHinting(false)
    }
  }

  function previousPosition() {
    if (!adaptive || liveHistoryPly === 0) return
    const current = historyPly == null ? liveHistoryPly : requestedHistoryPly
    setHistoryPly(Math.max(0, current - 1))
  }

  function nextPosition() {
    if (!adaptive || historyPly == null) return
    if (requestedHistoryPly >= liveHistoryPly - 1) {
      setHistoryPly(null)
    } else {
      setHistoryPly(requestedHistoryPly + 1)
    }
  }

  function selectHistoryPosition(ply: number) {
    if (ply >= liveHistoryPly) {
      setHistoryPly(null)
    } else {
      setHistoryPly(Math.max(0, ply))
    }
  }

  async function skip() {
    if (!puzzle || submitting || reviewingHistory) return
    try {
      setSubmitting(true)
      if (mode === 'adaptive' && adaptive?.status === 'active') {
        await api.adaptiveAbandon(adaptive.session_id)
      }
      await api.skip(puzzle.puzzle_id)
      await load()
    } catch (x) {
      setError((x as Error).message)
      setSubmitting(false)
    }
  }

  const clickToMove = useClickToMove(boardFen ?? puzzle?.fen)

  if (error && puzzle === undefined) return <section><Heading kicker="PRACTICE" title="Puzzle trainer" copy="Solve positions from your own games." /><ErrorBox message={error} /><button onClick={() => { void load() }}>Retry</button></section>
  if (puzzle === undefined) return <p className="muted">Loading next puzzle…</p>
  if (!puzzle) return <section className="empty"><h1>You're caught up</h1><p>No puzzles are due right now.</p></section>

  const adaptiveReview = adaptive?.review
  const adaptiveActive = mode === 'adaptive' && adaptive?.status === 'active'
  const boardEnabled = !submitting && !finished && !reviewingHistory && (mode === 'quick' || adaptiveActive)
  const maxDecisions = adaptive?.max_user_decisions ?? 4
  const outcomeClass = adaptive?.status === 'failed' ? 'feedback bad' : 'feedback good'
  const hintShown = adaptiveHint?.current_fen === adaptive?.current_fen
  const historySteps = history.slice(1).flatMap((entry) => entry.step ? [entry.step] : [])

  return <section>
    <Heading kicker={`${puzzle.phase} · ${puzzle.motif}`} title={`${puzzle.orientation === 'white' ? 'White' : 'Black'} to move`} copy={`${puzzle.game} · ${puzzle.move}`} action={<span className="pill">Difficulty {puzzle.difficulty}/5</span>} />
    <div className="mode-toggle" aria-label="Practice mode">
      <button className={mode === 'adaptive' ? 'active' : ''} aria-pressed={mode === 'adaptive'} disabled={submitting || finished || adaptiveStartStatus === 'starting'} onClick={() => { void changeMode('adaptive') }}>Adaptive</button>
      <button className={mode === 'quick' ? 'active' : ''} aria-pressed={mode === 'quick'} disabled={submitting || finished || adaptiveStartStatus === 'starting'} onClick={() => { void changeMode('quick') }}>Quick</button>
      <span>{mode === 'adaptive' ? 'Continue until the idea is converted.' : 'One best move, then review.'}</span>
    </div>
    {error && <ErrorBox message={error} />}
    <div className="practice">
      <div className="board"><Chessboard options={{ position: boardFen ?? puzzle.fen, boardOrientation: puzzle.orientation === 'black' ? 'black' : 'white', allowDragging: boardEnabled, onPieceDrop: ({ sourceSquare, targetSquare }) => onDrop(sourceSquare, targetSquare), onSquareClick: clickToMove.onSquareClick(boardEnabled, onDrop), squareStyles: clickToMove.squareStyles(boardEnabled) }} /></div>
      <div className="panel practice-info">
        <h2>{puzzle.opening} <small>({puzzle.eco})</small></h2>
        {mode === 'adaptive' && historySteps.length ? <AdaptiveLine steps={historySteps} viewingPly={viewedHistoryPly} livePly={liveHistoryPly} reviewing={reviewingHistory} onSelectPly={selectHistoryPosition} onPrevious={previousPosition} onNext={nextPosition} /> : null}
        {mode === 'quick' ? (!feedback ? <><p className="muted">{submitting ? 'Checking your move…' : 'Find the strongest move. The engine answer stays hidden until you commit.'}</p><button className="ghost" disabled={submitting} onClick={() => { void skip() }}>Skip</button></> : <div className={feedback.correct ? 'feedback good' : 'feedback bad'}><h3>{feedback.correct ? 'Correct' : 'Not quite'}</h3><p>Best move: <strong>{feedback.best_move_san}</strong></p>{!feedback.correct && <p>Your game move: <strong>{feedback.your_game_move}</strong></p>}{feedback.quality && <div className="move-quality"><h4>{titleCaseLabel(feedback.quality)}</h4>{feedback.quality_reason && <p>{titleCaseLabel(feedback.quality_reason)}</p>}</div>}{feedback.evaluation_loss_pawns != null && <p>Evaluation loss: {feedback.evaluation_loss_pawns.toFixed(2)} pawns</p>}<p>Next review: +{feedback.next_interval_days} days</p>{feedback.source_url && <a href={feedback.source_url} target="_blank" rel="noreferrer">Open source game ↗</a>}<button className="ghost" disabled={explaining} onClick={() => { void explainBestMove() }}>{explaining ? 'Analyzing why…' : 'Why is this best?'}</button>{explanationError && <ErrorBox message={explanationError} />}{explanation && <ExplanationView explanation={explanation} startFen={puzzle.fen} />}<button onClick={() => { void load() }}>Next puzzle</button></div>) : (
          !adaptive ? (adaptiveStartStatus === 'failed'
            ? <button onClick={() => { void startAdaptiveDrill(puzzle.puzzle_id) }}>Retry</button>
            : <p className="muted">Starting adaptive drill…</p>) : adaptiveActive ? <div className="adaptive-live"><p className="muted">{reviewingHistory ? 'Reviewing the played line. Use Next to continue.' : submitting ? 'Checking the continuation…' : hinting ? 'Finding the next best move…' : lastAdaptiveMove?.accepted ? 'Strong. Continuing the line…' : lastAdaptiveMove?.accepted === false ? 'Not quite. Try again — the position stays the same.' : 'Find the strongest move. Strong alternatives are accepted.'}</p>{!reviewingHistory && lastAdaptiveMove?.engine_reply_san && <p>Engine replied <strong>{lastAdaptiveMove.engine_reply_san}</strong></p>}{!reviewingHistory && hintShown && adaptiveHint && <p>Next best move: <strong>{adaptiveHint.move_san}</strong></p>}<p className="sequence-progress">{adaptive.user_moves_accepted} / up to {maxDecisions} decisions</p><button className="ghost" disabled={submitting || hinting || hintShown || reviewingHistory} onClick={() => { void showNextBestMove() }}>{hinting ? 'Finding move…' : hintShown ? 'Move shown' : 'Show next best move'}</button><button className="ghost" disabled={submitting || hinting || reviewingHistory} onClick={() => { void skip() }}>Skip</button></div> : <div className={outcomeClass}><h3>{adaptive.status === 'succeeded' ? 'Converted' : adaptive.status === 'failed' ? 'Continuation missed' : 'Drill ended'}</h3><p>{adaptive.user_moves_accepted}/{adaptive.user_moves_attempted} strong decisions</p><p>Calculation depth: {adaptive.current_ply} plies</p><p>Maximum evaluation loss: {(adaptive.max_eval_loss_cp / 100).toFixed(2)} pawns</p>{adaptiveReview && <p>Next review: +{adaptiveReview.next_interval_days} days</p>}{puzzle.source_url && <a href={puzzle.source_url} target="_blank" rel="noreferrer">Open source game ↗</a>}<button className="ghost" disabled={explaining} onClick={() => { void explainBestMove() }}>{explaining ? 'Analyzing why…' : 'Why is this best?'}</button>{explanationError && <ErrorBox message={explanationError} />}{explanation && <ExplanationView explanation={explanation} startFen={puzzle.fen} />}<button onClick={() => { void load() }}>Next puzzle</button></div>
        )}
      </div>
    </div>
  </section>
}

function appendAdaptiveSteps(steps: AdaptiveSafeStep[], result: AdaptiveMoveResult): AdaptiveSafeStep[] {
  const next = steps.filter((step) => step.accepted)
  let stepIndex = next.reduce((highest, step) => Math.max(highest, step.step_index), -1) + 1
  if (result.accepted === true && result.move_uci && result.move_san) {
    next.push({ step_index: stepIndex, side: 'user', move_uci: result.move_uci, move_san: result.move_san, accepted: true })
    stepIndex += 1
  }
  if (result.engine_reply_uci && result.engine_reply_san) {
    next.push({ step_index: stepIndex, side: 'engine', move_uci: result.engine_reply_uci, move_san: result.engine_reply_san, accepted: true })
  }
  return next
}

function AdaptiveLine({ steps, viewingPly, livePly, reviewing, onSelectPly, onPrevious, onNext }: {
  steps: AdaptiveSafeStep[]
  viewingPly: number
  livePly: number
  reviewing: boolean
  onSelectPly: (ply: number) => void
  onPrevious: () => void
  onNext: () => void
}) {
  return <div className="adaptive-line">
    <strong>Line so far</strong>
    <ol>{steps.map((step, index) => {
      const ply = index + 1
      const label = step.side === 'user' ? `${Math.floor(index / 2) + 1}. ${step.move_san}` : `… ${step.move_san}`
      return <li key={step.step_index}><button type="button" className="history-move" aria-current={viewingPly === ply ? 'step' : undefined} onClick={() => onSelectPly(ply)}>{label}</button></li>
    })}</ol>
    <div className="adaptive-history-controls">
      <button type="button" className="ghost" aria-label="Previous position" disabled={viewingPly <= 0} onClick={onPrevious}>← Previous</button>
      <span>Ply {viewingPly} / {livePly}</span>
      <button type="button" className="ghost" aria-label="Next position" disabled={viewingPly >= livePly} onClick={onNext}>Next →</button>
    </div>
    {reviewing && <p className="adaptive-history-note">Reviewing earlier position</p>}
  </div>
}

function ExplanationView({ explanation, startFen }: { explanation: Explanation; startFen: string }) {
  return <div className="explanation"><p className="kicker">{explanation.engine_grounded ? `STOCKFISH · DEPTH ${explanation.depth}` : 'BOARD-ONLY FALLBACK'}</p><h3>{explanation.idea}</h3><p>{explanation.why}</p><p><strong>Best line:</strong> {formatMoveLine(startFen, explanation.best_line)}</p><p><strong>Why your move was worse:</strong> {explanation.why_your_move_was_worse}</p></div>
}

