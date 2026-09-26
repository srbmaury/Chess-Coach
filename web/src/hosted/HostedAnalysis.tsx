// The hosted (multi-user) experience: magic-link sign-in, Chess.com player profiles,
// shared browser-computed analysis with live progress, and ready results. Hosted mode
// never shows the local Pipeline page; computation happens in the browser.
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Chessboard } from 'react-chessboard'

import type { ModelSummary } from '../analysis/model'
import type { PuzzleSeed } from '../analysis/puzzles'
import type { HostedApi } from './api'
import type { CoordinatorSnapshot } from './coordinator'
import type { Capabilities } from './device'
import { useClickToMove } from '../useClickToMove'
import Markdown from './Markdown'
import { createDefaultServices, type CoordinatorLike, type HostedConfig, type HostedServices } from './services'
import type { ArtifactView, JobView, ProfileView } from './types'
import './hosted.css'

type Props = { config: HostedConfig; services?: HostedServices }

export default function HostedAnalysis({ config, services: injected }: Props) {
  const services = useMemo(() => injected ?? createDefaultServices(config), [injected, config])
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)

  useEffect(() => services.observeSession(setSession), [services])
  useEffect(() => {
    let active = true
    void services.capabilities().then((value) => { if (active) setCapabilities(value) })
    return () => { active = false }
  }, [services])

  return <div className="hosted-shell">
    <header className="hosted-header">
      <div className="brand"><b>♞</b><div><strong>Chess ML Coach</strong><small>Shared analysis</small></div></div>
      {session && <div className="hosted-account">
        <span className="muted">{session.user?.email}</span>
        <button className="ghost" onClick={() => { void services.logout() }}>Sign out</button>
      </div>}
    </header>
    <main className="hosted-main">
      {session === undefined && <p className="muted">Loading…</p>}
      {session === null && <SignIn services={services} />}
      {session && <Workspace session={session} services={services} capabilities={capabilities} />}
    </main>
  </div>
}

function SignIn({ services }: { services: HostedServices }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await services.requestMagicLink(email)
      setSent(true)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel hosted-narrow">
    <p className="kicker">SIGN IN</p>
    <h1>Train on your own games</h1>
    <p className="muted">We email you a one-time sign-in link. No password needed.</p>
    {sent
      ? <p role="status">Check your email for a sign-in link.</p>
      : <form onSubmit={submit} className="hosted-inline-form">
        <input aria-label="Email address" type="email" autoComplete="email" value={email}
          onChange={(event) => setEmail(event.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Email me a link'}</button>
      </form>}
    {error && <p className="hosted-error" role="alert">{error}</p>}
  </section>
}

function Workspace({ session, services, capabilities }: { session: Session; services: HostedServices; capabilities: Capabilities | null }) {
  const api = useMemo(() => services.createApi(session), [services, session])
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null)
  const [analysisEnabled, setAnalysisEnabled] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await api.profiles()
      setProfiles(data.profiles)
      setAnalysisEnabled(data.analysis_enabled)
      setSelected((current) => current ?? data.profiles[0]?.player_id ?? null)
    } catch (caught) {
      setError((caught as Error).message)
      setProfiles((current) => current ?? [])
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  async function addPlayer(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await api.claimProfile(username.trim())
      setProfiles(data.profiles)
      const added = data.profiles.find((profile) => profile.username === username.trim().toLowerCase())
      if (added) setSelected(added.player_id)
      setUsername('')
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!profiles) return <p className="muted">Loading your players…</p>
  const profile = profiles.find((item) => item.player_id === selected) ?? null
  const freeUsed = profiles.some((item) => item.slot_type === 'free')

  return <div className="hosted-workspace">
    <aside className="hosted-profiles">
      <h2>Players</h2>
      <ul>
        {profiles.map((item) => <li key={item.player_id}>
          <button className={item.player_id === selected ? 'hosted-profile active' : 'hosted-profile'}
            onClick={() => setSelected(item.player_id)} aria-pressed={item.player_id === selected}>
            <strong>{item.display_username}</strong>
            <small>{item.slot_type === 'free' ? 'Free player' : 'Additional player'}
              {item.state === 'read_only' ? ' · read-only' : ''}
              {item.has_results ? ' · results ready' : ''}</small>
          </button>
        </li>)}
      </ul>
      <form onSubmit={addPlayer} className="hosted-inline-form">
        <input aria-label="Chess.com username" placeholder="Chess.com username" value={username}
          onChange={(event) => setUsername(event.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !username.trim()}>Add</button>
      </form>
      <p className="muted hosted-small">
        {freeUsed
          ? 'Your free player is set. A subscription adds up to five more players.'
          : 'Your first player is free.'}
      </p>
      {error && <p className="hosted-error" role="alert">{error}</p>}
    </aside>
    <section className="hosted-detail">
      {profile
        ? <PlayerView key={profile.player_id} profile={profile} api={api} services={services} session={session}
          analysisEnabled={analysisEnabled} capabilities={capabilities} onChanged={refresh} />
        : <div className="panel"><h1>Add a Chess.com player</h1>
          <p className="muted">Enter the username whose games you want to study.</p></div>}
    </section>
  </div>
}

const ACTIVE_JOB = new Set(['queued', 'running', 'paused'])

function useCoordinator(
  services: HostedServices, api: HostedApi, session: Session, job: JobView | null, computeAllowed: boolean,
) {
  const [snapshot, setSnapshot] = useState<CoordinatorSnapshot | null>(null)
  const [coordinator, setCoordinator] = useState<CoordinatorLike | null>(null)
  const jobId = job && ACTIVE_JOB.has(job.status) && job.subscription_state === 'active' ? job.id : null

  useEffect(() => {
    if (!jobId) return
    let disposed = false
    let instance: CoordinatorLike | null = null
    let feed: { close(): void } | null = null
    void (async () => {
      instance = await services.createCoordinator(api, computeAllowed)
      if (disposed) {
        instance.dispose()
        return
      }
      instance.subscribe((next) => { if (!disposed) setSnapshot(next) })
      setCoordinator(instance)
      await instance.start(jobId)
      try {
        feed = await services.subscribeProgress(session, jobId, () => instance?.nudge(), () => undefined)
        if (disposed) feed.close()
      } catch {
        // Realtime is optional; polling keeps progress current.
      }
    })()
    return () => {
      disposed = true
      feed?.close()
      instance?.dispose()
      setCoordinator(null)
    }
    // computeAllowed changes are applied through setComputeAllowed, not a restart.
  }, [services, api, session, jobId])

  return { snapshot, coordinator }
}

function statusText(snapshot: CoordinatorSnapshot | null, job: JobView | null): string {
  switch (snapshot?.state) {
    case 'claiming': return 'Getting ready to analyze on this device…'
    case 'running': return snapshot.message ?? 'Analyzing on this device'
    case 'uploading': return 'Saving progress…'
    case 'paused': return snapshot.message ?? 'Paused'
    case 'lease_lost': return snapshot.message ?? 'Another browser took over this analysis'
    case 'failed': return snapshot.message ?? 'Analysis stopped'
    case 'stopped': return 'You stopped following this analysis'
    case 'succeeded': return 'Analysis complete'
    case 'observing': return snapshot.message ?? (job?.worker_active ? 'Another browser is analyzing' : 'Waiting for a browser to analyze')
    default: return job?.worker_active ? 'Another browser is analyzing' : 'Waiting to start'
  }
}

type LoadedResults = {
  artifacts: ArtifactView[]
  report?: { markdown: string }
  puzzles?: { puzzles: PuzzleSeed[] }
  model?: ModelSummary
}

function PlayerView({ profile, api, services, session, analysisEnabled, capabilities, onChanged }: {
  profile: ProfileView
  api: HostedApi
  services: HostedServices
  session: Session
  analysisEnabled: boolean
  capabilities: Capabilities | null
  onChanged: () => void
}) {
  const [job, setJob] = useState<JobView | null>(profile.latest_job)
  const [computeAllowed, setComputeAllowed] = useState(false)
  const [computeTouched, setComputeTouched] = useState(false)
  const [results, setResults] = useState<LoadedResults | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { snapshot, coordinator } = useCoordinator(services, api, session, job, computeAllowed)

  useEffect(() => {
    if (!computeTouched && capabilities) setComputeAllowed(capabilities.supported && capabilities.recommended && (job?.can_compute ?? true))
  }, [capabilities, computeTouched, job?.can_compute])

  const loadResults = useCallback(async () => {
    try {
      const response = await api.results(profile.player_id)
      const loaded: LoadedResults = { artifacts: response.artifacts }
      await Promise.all(response.artifacts.map(async (artifact) => {
        if (!artifact.download_url) return
        const document = await services.downloadArtifact<Record<string, unknown>>(artifact.download_url)
        if (artifact.artifact_type === 'report') loaded.report = document as { markdown: string }
        if (artifact.artifact_type === 'puzzles') loaded.puzzles = document as { puzzles: PuzzleSeed[] }
        if (artifact.artifact_type === 'model_summary') loaded.model = document as unknown as ModelSummary
      }))
      setResults(loaded)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [api, profile.player_id, services])

  useEffect(() => { void loadResults() }, [loadResults])

  const state = snapshot?.state
  useEffect(() => {
    if (state === 'succeeded') {
      void loadResults()
      onChanged()
    }
    // onChanged is stable enough; refresh once per completion.
  }, [state, loadResults])
  useEffect(() => { if (snapshot?.job) setJob(snapshot.job) }, [snapshot?.job])

  async function analyze() {
    setBusy(true)
    setError('')
    try {
      setJob(await api.createJob(profile.player_id, computeAllowed))
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleCompute(next: boolean) {
    setComputeTouched(true)
    setComputeAllowed(next)
    try {
      if (coordinator) await coordinator.setComputeAllowed(next)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  async function stop() {
    setError('')
    try {
      await coordinator?.stopObserving()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  // The coordinator's snapshot is the freshest view; fall back to the last API response.
  const current = snapshot?.job ?? job
  const active = current && ACTIVE_JOB.has(current.status) && current.subscription_state === 'active' && snapshot?.state !== 'stopped'
  const total = current?.total_units ?? 0
  const completed = current?.completed_units ?? 0
  const local = snapshot?.localUnits ?? 0
  const percent = total ? Math.min(100, Math.round(((completed + local) / total) * 100)) : 0
  const readOnly = profile.state === 'read_only'

  return <div>
    <div className="heading">
      <div>
        <p className="kicker">PLAYER</p>
        <h1>{profile.display_username}</h1>
        {results?.artifacts.length
          ? <span className="tag hosted-badge" title="Computed by players' browsers, not verified by the server">Community computed</span>
          : null}
      </div>
    </div>

    {!analysisEnabled && <div className="panel"><p className="muted">Shared analysis is not enabled yet. Existing results stay available.</p></div>}

    {analysisEnabled && <section className="panel" aria-label="Analysis">
      <h2>Analysis</h2>
      {capabilities && !capabilities.supported && <p className="muted" role="note">{capabilities.reason}</p>}
      {readOnly && <p className="muted">This player is read-only until your subscription is renewed. Existing results stay available.</p>}
      <label className="hosted-toggle">
        <input type="checkbox" checked={computeAllowed} disabled={!capabilities?.supported || readOnly}
          onChange={(event) => { void toggleCompute(event.target.checked) }} />
        Use this device to analyze
      </label>
      {capabilities?.supported && !capabilities.recommended && capabilities.reason && <p className="muted hosted-small">{capabilities.reason}</p>}
      {active
        ? <div className="hosted-progress">
          <p role="status">{statusText(snapshot, current)}</p>
          {snapshot?.resumed && snapshot.state === 'running' && <p className="muted hosted-small">Resumed from the last saved checkpoint.</p>}
          <div className="hosted-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted hosted-small">{completed} of {total} games saved{local ? ` · ${local} more analyzed here` : ''}</p>
          <button className="ghost" onClick={() => { void stop() }}>Stop following</button>
        </div>
        : <div>
          {snapshot?.state === 'stopped' && <p className="muted" role="status">You stopped following this analysis. Results already finished stay available.</p>}
          {snapshot?.state === 'failed' && <p className="hosted-error" role="alert">{snapshot.message}</p>}
          <button onClick={() => { void analyze() }} disabled={busy || readOnly || !capabilities}>
            {results?.artifacts.length ? 'Update with new games' : 'Analyze my games'}
          </button>
        </div>}
    </section>}

    {error && <p className="hosted-error" role="alert">{error}</p>}
    <Results results={results} />
  </div>
}

function Results({ results }: { results: LoadedResults | null }) {
  const [tab, setTab] = useState<'report' | 'puzzles' | 'model'>('report')
  if (!results) return null
  if (!results.artifacts.length) {
    return <div className="panel"><p className="muted">No results yet. They appear here as soon as analysis finishes.</p></div>
  }
  return <section className="panel">
    <div className="mode-toggle" role="tablist">
      {(['report', 'puzzles', 'model'] as const).map((name) => (
        <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
          {name === 'report' ? 'Report' : name === 'puzzles' ? 'Puzzles' : 'Mistake model'}
        </button>
      ))}
    </div>
    {tab === 'report' && (results.report ? <Markdown source={results.report.markdown} /> : <p className="muted">Report unavailable.</p>)}
    {tab === 'puzzles' && <Puzzles puzzles={results.puzzles?.puzzles ?? []} />}
    {tab === 'model' && <Model model={results.model} />}
  </section>
}

function Puzzles({ puzzles }: { puzzles: PuzzleSeed[] }) {
  const [index, setIndex] = useState(0)
  const [feedback, setFeedback] = useState<string | null>(null)
  const puzzle = puzzles.length ? puzzles[Math.min(index, puzzles.length - 1)] : null
  const clickToMove = useClickToMove(puzzle?.fen_before)
  if (!puzzle) return <p className="muted">No puzzles yet — no significant mistakes were found.</p>
  const orientation = puzzle.color === 'black' ? 'black' : 'white'
  const next = () => { setIndex((index + 1) % puzzles.length); setFeedback(null) }
  const tryMove = (sourceSquare: string, targetSquare: string | null) => {
    if (!targetSquare) return false
    const correct = puzzle.best_move_uci.startsWith(`${sourceSquare}${targetSquare}`)
    setFeedback(correct ? `Correct — ${puzzle.best_move_san}` : `Not quite. The best move was ${puzzle.best_move_san}.`)
    return false
  }
  return <div className="practice">
    <div className="board">
      <Chessboard options={{
        position: puzzle.fen_before,
        boardOrientation: orientation,
        onPieceDrop: ({ sourceSquare, targetSquare }) => tryMove(sourceSquare, targetSquare),
        onSquareClick: clickToMove.onSquareClick(true, tryMove),
        squareStyles: clickToMove.squareStyles(true),
      }} />
    </div>
    <div className="practice-info">
      <p className="kicker">PUZZLE {index + 1} OF {puzzles.length}</p>
      <h2>{puzzle.game_label}</h2>
      <p className="muted">{puzzle.move_label} — you played {puzzle.your_move_san}. Find a better move.</p>
      <div className="hosted-tags">
        <span className="tag">{puzzle.motif}</span>
        <span className={`tag ${puzzle.quality}`}>{puzzle.quality}</span>
        <span className="tag">{puzzle.game_phase}</span>
      </div>
      {feedback && <p className="feedback" role="status">{feedback}</p>}
      <button onClick={next}>Next puzzle</button>
    </div>
  </div>
}

function Model({ model }: { model?: ModelSummary }) {
  if (!model) return <p className="muted">Model summary unavailable.</p>
  if (model.status !== 'trained') return <p className="muted">Not enough data to train the mistake model yet: {model.reason}.</p>
  const top = model.feature_importance.slice(0, 8)
  const total = model.feature_importance.reduce((sum, item) => sum + item.importance, 0) || 1
  return <div>
    <p className="muted">A lightweight model of when you tend to make significant mistakes. Importance is associative, not causal.</p>
    <ul className="hosted-features">
      {top.map((item) => <li key={item.feature}>
        <span>{item.feature.replace(/^(numeric|categorical)__/, '').split('_').join(' ')}</span>
        <b>{Math.round((item.importance / total) * 100)}%</b>
      </li>)}
    </ul>
    {model.metrics.roc_auc !== null && <p className="muted hosted-small">Holdout ROC AUC {model.metrics.roc_auc.toFixed(2)} on {model.test_rows} recent moves.</p>}
  </div>
}
