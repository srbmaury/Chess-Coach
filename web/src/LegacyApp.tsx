import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts'
import { apiFetch, requestJson } from './apiTransport'
import { HostedContext, useHosted, type HostedEnvironment } from './hostedContext'


import OpeningsPage from './openings/OpeningsPage'
import { ErrorBox, Heading } from './pageControls'
import PracticePage, { type PracticePuzzle } from './practice/PracticePage'

type Training = { total_puzzles: number; due_puzzles: number; reviewed_puzzles: number; mastered_puzzles: number; total_reviews: number; accuracy: number | null }
type Dashboard = { analyzed_moves: number; training: Training; artifacts: Record<string, { exists: boolean; updated_at?: string | null; rows?: number | null }> }
type PuzzleItem = PracticePuzzle & { your_move_san: string; your_move_uci: string; best_move_san: string; best_move_uci: string; evaluation_loss_pawns: number | null; quality: string; quality_reason?: string; attempts: number; correct_attempts: number; accuracy: number | null; consecutive_correct: number; next_review_at: string; mastered: boolean }
type GroupRow = { label: string; puzzles: number; attempts: number; correct: number; accuracy: number | null }
type AdaptiveProgress = {
  sessions_completed: number
  success_rate: number | null
  continuation_accuracy: number | null
  average_accepted_decisions: number | null
  average_calculation_depth_plies: number | null
}
type Progress = Training & { by_motif: GroupRow[]; by_opening: GroupRow[]; daily_reviews: Array<{ date: string; reviews: number; correct: number; accuracy: number }>; adaptive?: AdaptiveProgress }
const api = {
  dashboard: () => requestJson<Dashboard>('/api/dashboard'),
  progress: () => requestJson<Progress>('/api/progress'),
  puzzles: (query = '') => requestJson<{ items: PuzzleItem[]; total: number; limit: number; offset: number }>(`/api/puzzles${query}`),
  pipelineStatus: () => requestJson<Record<string, unknown>>('/api/pipeline/status'),
  startPipeline: (stage: string, options?: Record<string, unknown>) => requestJson<Record<string, unknown>>(`/api/pipeline/${stage}`, { method: 'POST', body: JSON.stringify(options || {}) }),
  stopPipeline: () => requestJson<Record<string, unknown>>('/api/pipeline/stop', { method: 'POST' }),
}

const percentage = (value: number | null) => value == null ? '—' : `${(value * 100).toFixed(1)}%`
const decimal = (value: number | null) => value == null ? '—' : value.toFixed(1)
function Shell() {
  const hosted = useHosted()
  const nav = [['/', 'Dashboard'], ['/practice', 'Practice'], ['/mistakes', 'Mistakes'], ['/openings', 'Openings'], ['/progress', 'Progress'], ['/pipeline', 'Pipeline']]
  return <div className="shell"><aside><div className="brand"><b>♞</b><div><strong>Chess ML Coach</strong><small>Personal training lab</small></div></div><nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav></aside><main><Routes><Route path="/" element={<DashboardPage />} /><Route path="/practice" element={<PracticePage />} /><Route path="/mistakes" element={<MistakesPage />} /><Route path="/openings" element={<OpeningsPage />} /><Route path="/progress" element={<ProgressPage />} /><Route path="/pipeline" element={<PipelinePage />} />{hosted && <Route path="/report" element={<ReportPage />} />}</Routes></main></div>
}

/** Hosted mode shows the report in-app: a new tab could not carry the session token. */
function ReportPage() {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    apiFetch('/api/report').then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail || `Request failed (${response.status})`)
      }
      setHtml(await response.text())
    }).catch((x: Error) => setError(x.message))
  }, [])
  if (error) return <ErrorBox message={error} />
  if (html === null) return <p className="muted">Loading report…</p>
  return <section><Heading kicker="REPORT" title="Coaching report" copy="Where your mistakes cluster, from your latest analysis." action={<NavLink className="button ghost" to="/">Back</NavLink>} /><iframe className="report-frame" title="Coaching report" sandbox="" srcDoc={html} /></section>
}

function Metric({ label, value }: { label: string; value: string | number }) { return <article className="metric"><span>{label}</span><strong>{value}</strong></article> }

function DashboardPage() {
  const hosted = useHosted()
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.dashboard().then(setData).catch((x: Error) => setError(x.message)) }, [])
  if (error) return <ErrorBox message={error} />
  if (!data) return <p className="muted">Loading dashboard…</p>
  return <section><Heading kicker="TODAY" title="Your training cockpit" copy="Use your own mistakes as the next study plan." action={<NavLink className="button" to="/practice">Start practice</NavLink>} /><div className="metrics"><Metric label="Due puzzles" value={data.training.due_puzzles} /><Metric label="Mastered" value={data.training.mastered_puzzles} /><Metric label="Review accuracy" value={percentage(data.training.accuracy)} /><Metric label="Analyzed moves" value={data.analyzed_moves.toLocaleString()} /></div><div className="panel"><h2>Pipeline readiness</h2><div className="artifacts">{Object.entries(data.artifacts).map(([key, value]) => {
    const content = <><i className={value.exists ? 'ready' : ''} /><span><strong>{key}</strong><small>{value.exists ? 'Ready' : 'Not built yet'}</small></span></>
    if (key === 'report' && value.exists) {
      return hosted
        ? <NavLink className="artifact" key={key} to="/report">{content}</NavLink>
        : <a className="artifact" key={key} href="/api/report" target="_blank" rel="noopener noreferrer">{content}</a>
    }
    return <div className="artifact" key={key}>{content}</div>
  })}</div></div></section>
}

function MistakesPage() {
  const [items, setItems] = useState<PuzzleItem[]>([])
  const [quality, setQuality] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api.puzzles(quality ? `?quality=${quality}` : '').then((r) => setItems(r.items)).catch((x: Error) => setError(x.message)) }, [quality])
  return <section><Heading kicker="EXPLORE" title="Your mistakes" copy="Browse training positions without waiting for them to become due." /><div className="toolbar"><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="">All quality</option><option value="miss">Miss</option><option value="blunder">Blunders</option><option value="mistake">Mistakes</option></select></div>{error && <ErrorBox message={error} />}<div className="list">{items.map((item) => <article className="row" key={item.puzzle_id}><div><span className={`tag ${item.quality}`}>{item.quality}</span><h3>{item.game} · {item.move}</h3><p>{item.opening} ({item.eco}) · {item.phase} · {item.motif}</p></div><div className="moves"><span>You <b>{item.your_move_san}</b></span><span>Best <b>{item.best_move_san}</b></span>{item.evaluation_loss_pawns == null ? <span>{item.quality_reason || 'Mate-related evaluation'}</span> : <span>Loss <b>{item.evaluation_loss_pawns.toFixed(2)} pawns</b></span>}</div>{item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer">Game ↗</a>}</article>)}</div></section>
}

function ProgressPage() {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.progress().then(setProgress).catch((x: Error) => setError(x.message)) }, [])
  if (error) return <ErrorBox message={error} />
  if (!progress) return <p className="muted">Loading progress…</p>
  const adaptive = progress.adaptive ?? { sessions_completed: 0, success_rate: null, continuation_accuracy: null, average_accepted_decisions: null, average_calculation_depth_plies: null }
  return <section><Heading kicker="TRAINING" title="Progress" copy="Measure puzzle mastery and practice consistency." /><div className="metrics"><Metric label="Reviewed" value={progress.reviewed_puzzles} /><Metric label="Mastered" value={progress.mastered_puzzles} /><Metric label="Total reviews" value={progress.total_reviews} /><Metric label="Accuracy" value={percentage(progress.accuracy)} /></div><div className="panel"><h2>Review activity</h2><ResponsiveContainer width="100%" height={250}><LineChart data={progress.daily_reviews}><XAxis dataKey="date" tick={{ fill: 'var(--muted)' }} axisLine={{ stroke: 'var(--line)' }} tickLine={{ stroke: 'var(--line)' }} /><YAxis allowDecimals={false} tick={{ fill: 'var(--muted)' }} axisLine={{ stroke: 'var(--line)' }} tickLine={{ stroke: 'var(--line)' }} /><Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} itemStyle={{ color: 'var(--text)' }} /><Line type="monotone" dataKey="reviews" stroke="var(--accent)" strokeWidth={2} /></LineChart></ResponsiveContainer></div><div className="panel"><h2>Adaptive calculation</h2><div className="adaptive-metrics"><Metric label="Adaptive drills" value={adaptive.sessions_completed} /><Metric label="Conversion rate" value={percentage(adaptive.success_rate)} /><Metric label="Continuation accuracy" value={percentage(adaptive.continuation_accuracy)} /><Metric label="Avg strong decisions" value={decimal(adaptive.average_accepted_decisions)} /><Metric label="Avg calculation depth" value={adaptive.average_calculation_depth_plies == null ? '—' : `${adaptive.average_calculation_depth_plies.toFixed(1)} plies`} /></div></div><div className="columns"><Ranking title="By motif" rows={progress.by_motif} /><Ranking title="By opening" rows={progress.by_opening} /></div></section>
}
function Ranking({ title, rows }: { title: string; rows: GroupRow[] }) { return <div className="panel"><h2>{title}</h2>{rows.slice(0, 8).map((row) => <div className="rank" key={row.label}><span>{row.label}</span><b>{percentage(row.accuracy)}</b></div>)}</div> }

/** Pipeline progress events: the local server's stream, or the hosted in-browser pipeline. */
function subscribePipeline(hosted: HostedEnvironment | null, listener: (progress: Record<string, any>) => void): () => void {
  if (hosted) return hosted.pipeline.subscribe(listener)
  const stream = new EventSource('/api/pipeline/events')
  stream.onmessage = (event) => {
    const progress = JSON.parse(event.data)
    listener(progress)
    if (['succeeded', 'failed', 'cancelled'].includes(progress.status)) stream.close()
  }
  return () => stream.close()
}

function PipelinePage() {
  const hosted = useHosted()
  const [status, setStatus] = useState<Record<string, any> | null>(null)
  const [depth, setDepth] = useState(hosted ? hosted.pipeline.depth : 14)
  const [error, setError] = useState('')
  const [streamGeneration, setStreamGeneration] = useState(0)
  const reportWindowRef = useRef<Window | null>(null)
  const refresh = useCallback(() => api.pipelineStatus().then(setStatus).catch((x: Error) => setError(x.message)), [])
  useEffect(() => {
    refresh()
    return subscribePipeline(hosted, (progress) => {
      setStatus((old) => ({ ...old, ...progress, progress }))
      if (progress.stage === 'report' && reportWindowRef.current && !reportWindowRef.current.closed) {
        if (progress.status === 'succeeded') {
          reportWindowRef.current.location.href = hosted ? '/report' : '/api/report'
          reportWindowRef.current = null
        } else if (progress.status === 'failed') {
          reportWindowRef.current.document.body.textContent = progress.error
            ? `Report generation failed: ${progress.error}`
            : 'Report generation failed.'
          reportWindowRef.current = null
        } else if (progress.status === 'cancelled') {
          reportWindowRef.current.close()
          reportWindowRef.current = null
        }
      }
    })
  }, [refresh, streamGeneration, hosted])

  async function start(stage: string) {
    try {
      setError('')
      if (stage === 'report') {
        // Open the tab synchronously, inside the click handler, so browsers
        // don't treat it as a popup: it's filled in once the (async) report
        // job reports success via the event stream below.
        const opened = window.open('about:blank', '_blank')
        if (opened) {
          opened.document.title = 'Coaching report'
          opened.document.body.textContent = 'Generating report… this can take up to a minute for a large game history. This tab will update automatically.'
        } else {
          setError('Your browser blocked the report tab. Allow pop-ups for this site, then click Run again.')
        }
        reportWindowRef.current = opened
      }
      setStatus(await api.startPipeline(stage, stage === 'analyze' || hosted ? { depth } : undefined))
      setStreamGeneration((value) => value + 1)
      window.setTimeout(refresh, 250)
    } catch (x) {
      setError((x as Error).message)
      reportWindowRef.current?.close()
      reportWindowRef.current = null
    }
  }

  async function stop() {
    try {
      setError('')
      setStatus(await api.stopPipeline())
    } catch (x) {
      setError((x as Error).message)
    }
  }

  const active = ['running', 'stopping'].includes(status?.status)
  const analyzeActive = active && status?.stage === 'analyze'
  return <section><Heading kicker="PIPELINE" title="Build your coach" copy="Run expensive operations here and watch them progress." />{error && <ErrorBox message={error} />}<div className="list">{['sync', 'analyze', 'features', 'puzzles', 'train', 'report'].map((stage) => <article className="stage" key={stage}><div><strong>{stage[0].toUpperCase() + stage.slice(1)}</strong><small>{stage === 'analyze' ? 'Stockfish evaluation' : stage === 'train' ? 'Personalized LightGBM model' : 'Pipeline stage'}</small></div>{stage === 'analyze' && <input aria-label="Stockfish depth" type="number" min={1} value={depth} disabled={analyzeActive} onChange={(event) => setDepth(Number(event.target.value))} />}{stage === 'analyze' && analyzeActive ? <button className="ghost" disabled={status?.status === 'stopping'} onClick={() => { void stop() }}>{status?.status === 'stopping' ? 'Stopping…' : 'Stop'}</button> : <button disabled={active} onClick={() => { void start(stage) }}>{active && status?.stage === stage ? 'Running…' : 'Run'}</button>}</article>)}</div>{status?.progress && <div className="panel"><h2>Live progress</h2><div className="progress-grid">{Object.entries(status.progress).filter(([key]) => !['created_at', 'sequence', 'stage'].includes(key)).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><b>{String(value)}</b></div>)}</div></div>}</section>
}

export default function App({ hosted = null }: { hosted?: HostedEnvironment | null }) {
  return <HostedContext.Provider value={hosted}><BrowserRouter><Shell /></BrowserRouter></HostedContext.Provider>
}
