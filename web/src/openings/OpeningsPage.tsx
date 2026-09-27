import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'

import { ALL_LESSONS, FAMILIES, TIERS, familyOf, lessonById } from './lessons'
import type { OpeningFamily, OpeningLesson } from './lessons'
import { MASTERED_BOX, lessonStatus, loadProgress, recordDrill, saveProgress } from './progress'
import type { LessonStatus, ProgressMap } from './progress'
import { useClickToMove } from '../useClickToMove'

const OPPONENT_REPLY_DELAY_MS = 450
const WRONG_TRIES_BEFORE_REVEAL = 2
const LAST_MOVE_STYLE = { background: 'rgba(215, 255, 117, 0.28)' }
const STATUS_LABEL: Record<LessonStatus, string> = { new: 'New', due: 'Due', learning: 'Learning', mastered: 'Mastered' }

type OpeningRow = { label: string; puzzles: number }
type Recommendation = { family: OpeningFamily; positions: number; labels: string[] }
type View =
  | { kind: 'catalog' }
  | { kind: 'lesson'; id: string; mode: 'learn' | 'drill'; attempt: number }
  | { kind: 'review'; queue: string[]; index: number; attempt: number }

function fenAt(lesson: OpeningLesson, ply: number): string {
  const board = new Chess()
  for (const move of lesson.moves.slice(0, ply)) board.move(move.san)
  return board.fen()
}

function lastMoveSquares(lesson: OpeningLesson, ply: number): Record<string, React.CSSProperties> {
  if (ply === 0) return {}
  const board = new Chess(fenAt(lesson, ply - 1))
  const played = board.move(lesson.moves[ply - 1].san)
  return { [played.from]: LAST_MOVE_STYLE, [played.to]: LAST_MOVE_STYLE }
}

function isLearnerPly(lesson: OpeningLesson, ply: number) {
  return (ply % 2 === 0) === (lesson.side === 'white')
}

function moveLabel(ply: number, san: string) {
  const number = Math.floor(ply / 2) + 1
  return ply % 2 === 0 ? `${number}.${san}` : `${number}…${san}`
}

function sideLabel(lesson: OpeningLesson) {
  return lesson.side === 'white' ? 'You play White' : 'You play Black'
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

// Chess.com labels look like "Sicilian Defense Najdorf Variation 6.Be3"; count
// the player's mistake positions per family so the weakest opening shows first.
export function recommendFamilies(rows: OpeningRow[]): Recommendation[] {
  const byFamily = new Map<string, Recommendation>()
  for (const row of rows) {
    const label = row.label.toLowerCase()
    const family = FAMILIES.find((candidate) => candidate.keywords.some((keyword) => label.includes(keyword)))
    if (!family || row.puzzles <= 0) continue
    const entry = byFamily.get(family.id) ?? { family, positions: 0, labels: [] }
    entry.positions += row.puzzles
    entry.labels.push(row.label)
    byFamily.set(family.id, entry)
  }
  return [...byFamily.values()].sort((a, b) => b.positions - a.positions).slice(0, 3)
}

export default function OpeningsPage() {
  const [progress, setProgress] = useState<ProgressMap>(() => loadProgress())
  const [view, setView] = useState<View>({ kind: 'catalog' })
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/progress')
      .then(async (response) => response.ok ? response.json() as Promise<{ by_opening?: OpeningRow[] }> : null)
      .then((body) => { if (!cancelled && body?.by_opening) setRecommendations(recommendFamilies(body.by_opening)) })
      // Recommendations are optional; the curriculum works without a pipeline.
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  function finishDrill(lessonId: string, mistakes: number) {
    setProgress((current) => {
      const next = { ...current, [lessonId]: recordDrill(current[lessonId], mistakes) }
      saveProgress(next)
      return next
    })
  }

  function startReview() {
    const due = ALL_LESSONS.filter((lesson) => lessonStatus(progress[lesson.id]) === 'due').map((lesson) => lesson.id)
    if (due.length) setView({ kind: 'review', queue: shuffle(due), index: 0, attempt: 0 })
  }

  if (view.kind === 'lesson') {
    const lesson = lessonById(view.id)
    if (!lesson) return null
    const back = <button type="button" className="ghost" onClick={() => setView({ kind: 'catalog' })}>← All openings</button>
    return <section>
      <div className="heading"><div><p className="kicker">{familyOf(lesson.id)?.name.toUpperCase()} · {lesson.eco}{lesson.kind === 'trap' ? ' · TRAP' : ''}</p><h1>{lesson.name}</h1><p>{lesson.summary}</p></div>{back}</div>
      <div className="mode-toggle" aria-label="Lesson mode">
        <button type="button" className={view.mode === 'learn' ? 'active' : ''} onClick={() => setView({ ...view, mode: 'learn', attempt: view.attempt + 1 })}>Learn</button>
        <button type="button" className={view.mode === 'drill' ? 'active' : ''} onClick={() => setView({ ...view, mode: 'drill', attempt: view.attempt + 1 })}>Drill</button>
        <span>{sideLabel(lesson)}</span>
      </div>
      {view.mode === 'learn'
        ? <LearnLine key={`learn-${lesson.id}-${view.attempt}`} lesson={lesson} onDrill={() => setView({ ...view, mode: 'drill', attempt: view.attempt + 1 })} />
        : <DrillLine
          key={`drill-${lesson.id}-${view.attempt}`}
          lesson={lesson}
          hideName={false}
          onFinish={(mistakes) => finishDrill(lesson.id, mistakes)}
          finishedActions={<>
            <button type="button" onClick={() => setView({ ...view, attempt: view.attempt + 1 })}>Drill again</button>
            <button type="button" className="ghost" onClick={() => setView({ kind: 'catalog' })}>Back to openings</button>
          </>}
        />}
    </section>
  }

  if (view.kind === 'review') {
    const lesson = lessonById(view.queue[view.index])
    if (!lesson) return null
    const isLast = view.index === view.queue.length - 1
    return <section>
      <div className="heading"><div><p className="kicker">MIXED REVIEW · {view.index + 1} OF {view.queue.length}</p><h1>Which line is this?</h1><p>Play from memory. The opening name is revealed when you finish.</p></div><button type="button" className="ghost" onClick={() => setView({ kind: 'catalog' })}>End review</button></div>
      <DrillLine
        key={`review-${lesson.id}-${view.attempt}`}
        lesson={lesson}
        hideName
        onFinish={(mistakes) => finishDrill(lesson.id, mistakes)}
        finishedActions={isLast
          ? <button type="button" onClick={() => setView({ kind: 'catalog' })}>Finish review</button>
          : <button type="button" onClick={() => setView({ ...view, index: view.index + 1, attempt: view.attempt + 1 })}>Next line</button>}
      />
    </section>
  }

  return <Catalog progress={progress} recommendations={recommendations} onOpen={(id, mode) => setView({ kind: 'lesson', id, mode, attempt: 0 })} onReview={startReview} />
}

function Catalog({ progress, recommendations, onOpen, onReview }: {
  progress: ProgressMap
  recommendations: Recommendation[]
  onOpen: (id: string, mode: 'learn' | 'drill') => void
  onReview: () => void
}) {
  const now = Date.now()
  const statuses = new Map(ALL_LESSONS.map((lesson) => [lesson.id, lessonStatus(progress[lesson.id], now)]))
  const learned = ALL_LESSONS.filter((lesson) => progress[lesson.id]).length
  const mastered = ALL_LESSONS.filter((lesson) => (progress[lesson.id]?.box ?? 0) >= MASTERED_BOX).length
  const due = ALL_LESSONS.filter((lesson) => statuses.get(lesson.id) === 'due').length
  const nextNew = ALL_LESSONS.find((lesson) => statuses.get(lesson.id) === 'new')

  return <section>
    <div className="heading">
      <div><p className="kicker">OPENINGS</p><h1>Opening lessons</h1><p>Learn each named line move by move, then drill it from memory until it sticks.</p></div>
      <div className="opening-actions">
        <button type="button" disabled={due === 0} onClick={onReview}>Review due ({due})</button>
        {nextNew && <button type="button" className="ghost" onClick={() => onOpen(nextNew.id, 'learn')}>Next: {nextNew.name}</button>}
      </div>
    </div>
    <div className="metrics">
      <article className="metric"><span>Lines started</span><strong>{learned} / {ALL_LESSONS.length}</strong></article>
      <article className="metric"><span>Mastered</span><strong>{mastered}</strong></article>
      <article className="metric"><span>Due now</span><strong>{due}</strong></article>
      <article className="metric"><span>Families</span><strong>{FAMILIES.length}</strong></article>
    </div>
    {recommendations.length > 0 && <div className="panel">
      <h2>Recommended from your games</h2>
      <div className="opening-recommendations">{recommendations.map(({ family, positions, labels }) => <button type="button" key={family.id} className="opening-card" onClick={() => onOpen(family.lessons[0].id, 'learn')}>
        <strong>{family.name}</strong>
        <small>{positions} mistake position{positions === 1 ? '' : 's'} in your games</small>
        <small className="muted">{labels.slice(0, 2).join(' · ')}</small>
      </button>)}</div>
    </div>}
    {TIERS.map((tier) => {
      const families = FAMILIES.filter((family) => family.tier === tier.id)
      return <div className="panel" key={tier.id}>
        <p className="kicker">TIER {tier.id}</p>
        <h2>{tier.title}</h2>
        <p className="muted">{tier.blurb}</p>
        {families.map((family) => <div className="opening-family" key={family.id}>
          <h3>{family.name}</h3>
          <div className="opening-grid">{family.lessons.map((lesson) => {
            const status = statuses.get(lesson.id) ?? 'new'
            return <button type="button" key={lesson.id} className="opening-card" onClick={() => onOpen(lesson.id, status === 'new' ? 'learn' : 'drill')}>
              <span className={`tag opening-status ${status}`}>{STATUS_LABEL[status]}</span>
              <strong>{lesson.name}</strong>
              <small>{lesson.eco} · {lesson.side === 'white' ? 'White' : 'Black'}{lesson.kind === 'trap' ? ' · Trap' : ''}</small>
            </button>
          })}</div>
        </div>)}
      </div>
    })}
  </section>
}

function MoveList({ lesson, ply, onSelect }: { lesson: OpeningLesson; ply: number; onSelect?: (ply: number) => void }) {
  return <div className="adaptive-line opening-line">
    <strong>Moves</strong>
    <ol>{lesson.moves.slice(0, onSelect ? lesson.moves.length : ply).map((move, index) => {
      const label = moveLabel(index, move.san)
      const style = index >= ply ? { opacity: 0.4 } : undefined
      return <li key={index} className={isLearnerPly(lesson, index) ? 'learner' : ''}>
        {onSelect
          ? <button type="button" className="history-move" style={style} aria-current={ply === index + 1 ? 'step' : undefined} onClick={() => onSelect(index + 1)}>{label}</button>
          : <span>{label}</span>}
      </li>
    })}</ol>
  </div>
}

function LearnLine({ lesson, onDrill }: { lesson: OpeningLesson; onDrill: () => void }) {
  const [ply, setPly] = useState(0)
  const total = lesson.moves.length
  const current = ply > 0 ? lesson.moves[ply - 1] : null
  const atEnd = ply === total

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowRight') setPly((value) => Math.min(value + 1, total))
      if (event.key === 'ArrowLeft') setPly((value) => Math.max(value - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [total])

  return <div className="practice">
    <div className="board"><Chessboard options={{ position: fenAt(lesson, ply), boardOrientation: lesson.side, allowDragging: false, squareStyles: lastMoveSquares(lesson, ply) }} /></div>
    <div className="panel practice-info">
      <div className="opening-comment">
        {current
          ? <><p className="kicker">{isLearnerPly(lesson, ply - 1) ? 'YOUR MOVE' : 'OPPONENT'} · {moveLabel(ply - 1, current.san)}</p><p>{current.why}</p></>
          : <><p className="kicker">THE IDEA</p><p>{lesson.summary}</p></>}
      </div>
      {atEnd && <div className="feedback good"><h3>The plan from here</h3><p>{lesson.plan}</p></div>}
      <MoveList lesson={lesson} ply={ply} onSelect={setPly} />
      <div className="adaptive-history-controls">
        <button type="button" className="ghost" aria-label="Previous move" disabled={ply === 0} onClick={() => setPly(ply - 1)}>← Previous</button>
        <span>{ply} / {total}</span>
        <button type="button" className="ghost" aria-label="Next move" disabled={atEnd} onClick={() => setPly(ply + 1)}>Next →</button>
      </div>
      <p className="muted opening-hint">Tip: use ← and → keys to step through the line.</p>
      <button type="button" onClick={onDrill}>{atEnd ? 'Drill this line' : 'Skip to drill'}</button>
    </div>
  </div>
}

type DrillFeedback = { tone: 'good' | 'bad'; title: string; text: string }

function DrillLine({ lesson, hideName, onFinish, finishedActions }: {
  lesson: OpeningLesson
  hideName: boolean
  onFinish: (mistakes: number) => void
  finishedActions: ReactNode
}) {
  const [ply, setPly] = useState(0)
  const [mistakes, setMistakes] = useState(0)
  const [wrongTries, setWrongTries] = useState(0)
  const [feedback, setFeedback] = useState<DrillFeedback | null>(null)
  const reported = useRef(false)
  const total = lesson.moves.length
  const finished = ply >= total
  const learnerTurn = !finished && isLearnerPly(lesson, ply)
  const expected = finished ? null : lesson.moves[ply]
  const revealed = wrongTries >= WRONG_TRIES_BEFORE_REVEAL
  const fen = fenAt(lesson, ply)
  const clickToMove = useClickToMove(fen)
  const learnerMoves = lesson.moves.filter((_, index) => isLearnerPly(lesson, index)).length

  useEffect(() => {
    if (finished || learnerTurn) return
    const timer = window.setTimeout(() => setPly((value) => value + 1), OPPONENT_REPLY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [finished, learnerTurn, ply])

  useEffect(() => {
    if (!finished || reported.current) return
    reported.current = true
    onFinish(mistakes)
  }, [finished, mistakes, onFinish])

  function missPly() {
    // Count at most one mistake per position so retries don't compound.
    if (wrongTries === 0) setMistakes((value) => value + 1)
  }

  function onDrop(sourceSquare: string, targetSquare: string | null) {
    if (!learnerTurn || !expected || !targetSquare) return false
    let san: string
    try {
      san = new Chess(fen).move({ from: sourceSquare, to: targetSquare, promotion: 'q' }).san
    } catch {
      return false
    }
    if (san === expected.san) {
      setFeedback({ tone: 'good', title: `${moveLabel(ply, san)} ✓`, text: expected.why })
      setWrongTries(0)
      setPly(ply + 1)
      return true
    }
    missPly()
    setWrongTries(wrongTries + 1)
    setFeedback({ tone: 'bad', title: `${san} isn't the book move`, text: wrongTries + 1 >= WRONG_TRIES_BEFORE_REVEAL ? 'The book move is shown with an arrow — play it to continue.' : 'Think about the idea of this opening and try again.' })
    return false
  }

  function reveal() {
    missPly()
    setWrongTries(WRONG_TRIES_BEFORE_REVEAL)
  }

  const arrows = revealed && learnerTurn && expected ? (() => {
    const move = new Chess(fen).move(expected.san)
    return [{ startSquare: move.from, endSquare: move.to, color: 'rgba(215, 255, 117, 0.85)' }]
  })() : []
  const lastOpponentMove = ply > 0 && !isLearnerPly(lesson, ply - 1) ? lesson.moves[ply - 1] : null

  return <div className="practice">
    <div className="board"><Chessboard options={{ position: fen, boardOrientation: lesson.side, allowDragging: learnerTurn, onPieceDrop: ({ sourceSquare, targetSquare }) => onDrop(sourceSquare, targetSquare), onSquareClick: clickToMove.onSquareClick(learnerTurn, onDrop), squareStyles: { ...lastMoveSquares(lesson, ply), ...clickToMove.squareStyles(learnerTurn) }, arrows }} /></div>
    <div className="panel practice-info">
      {!finished ? <>
        <p className="muted">{learnerTurn ? `${sideLabel(lesson)}. Play the book move.` : 'Opponent is thinking…'}</p>
        {lastOpponentMove && <div className="opening-comment"><p className="kicker">OPPONENT · {moveLabel(ply - 1, lastOpponentMove.san)}</p><p>{lastOpponentMove.why}</p></div>}
        {feedback && <div className={`feedback ${feedback.tone}`}><h3>{feedback.title}</h3><p>{feedback.text}</p></div>}
        {revealed && learnerTurn && expected && <p>Book move: <strong>{expected.san}</strong> — {expected.why}</p>}
        <p className="sequence-progress">{Math.ceil(ply / 2)} / {Math.ceil(total / 2)} moves · {mistakes} mistake{mistakes === 1 ? '' : 's'}</p>
        <button type="button" className="ghost" disabled={!learnerTurn || revealed} onClick={reveal}>Show move</button>
      </> : <div className={`feedback ${mistakes === 0 ? 'good' : 'bad'}`}>
        <h3>{mistakes === 0 ? 'Perfect recall' : `${mistakes} of ${learnerMoves} moves missed`}</h3>
        {hideName && <p>That was <strong>{lesson.name}</strong> ({familyOf(lesson.id)?.name}, {lesson.eco}).</p>}
        <p>{lesson.plan}</p>
        <p className="muted">{mistakes === 0 ? 'Scheduled further out. Nice.' : 'This line comes back soon for another pass.'}</p>
        <div className="opening-actions">{finishedActions}</div>
      </div>}
      <MoveList lesson={lesson} ply={ply} />
    </div>
  </div>
}
