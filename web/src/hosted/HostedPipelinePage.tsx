// The Pipeline page in hosted mode. Stockfish runs in the browser: the server syncs
// Chess.com games, one browser at a time analyzes them (shared with anyone else
// studying the same player, resumable from checkpoints), then builds the puzzles,
// report, and mistake model that the other pages use.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'

import { apiFetch } from '../apiTransport'
import { useHosted } from '../hostedContext'
import type { HostedApi } from './api'
import type { CoordinatorSnapshot } from './coordinator'
import type { Capabilities } from './device'
import type { CoordinatorLike, HostedServices } from './services'
import type { JobView, ProfileView } from './types'

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
    // Compute preference changes go through setComputeAllowed, not a restart.
  }, [services, api, session, jobId])

  return { snapshot, coordinator }
}

function workerText(snapshot: CoordinatorSnapshot | null, job: JobView | null): string {
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

type StageState = 'done' | 'running' | 'waiting' | 'failed'
const STAGE_LABEL: Record<StageState, string> = { done: 'Done', running: 'Running', waiting: 'Waiting', failed: 'Stopped' }

function Stage({ name, detail, state }: { name: string; detail: string; state: StageState }) {
  return <article className="stage">
    <div><strong>{name}</strong><small>{detail}</small></div>
    <span className={`pill stage-state ${state}`}>{STAGE_LABEL[state]}</span>
  </article>
}

export default function HostedPipelinePage() {
  const hosted = useHosted()!
  const { services, session } = hosted
  const api = useMemo(() => services.createApi(session), [services, session])
  const [profile, setProfile] = useState<ProfileView | null | undefined>(undefined)
  const [analysisEnabled, setAnalysisEnabled] = useState(true)
  const [job, setJob] = useState<JobView | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [computeAllowed, setComputeAllowed] = useState(false)
  const [computeTouched, setComputeTouched] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { snapshot, coordinator } = useCoordinator(services, api, session, job, computeAllowed)

  const load = useCallback(async () => {
    try {
      const [active, hostedProfiles] = await Promise.all([
        apiFetch('/api/profiles').then((response) => response.json() as Promise<{ active_username: string | null }>),
        api.profiles(),
      ])
      const current = hostedProfiles.profiles.find((item) => item.username === active.active_username) ?? null
      setAnalysisEnabled(hostedProfiles.analysis_enabled)
      setProfile(current)
      setJob(current?.latest_job ?? null)
    } catch (caught) {
      setError((caught as Error).message)
      setProfile(null)
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let active = true
    void services.capabilities().then((value) => { if (active) setCapabilities(value) })
    return () => { active = false }
  }, [services])
  useEffect(() => {
    if (!computeTouched && capabilities) {
      setComputeAllowed(capabilities.supported && capabilities.recommended && (job?.can_compute ?? true))
    }
  }, [capabilities, computeTouched, job?.can_compute])
  useEffect(() => { if (snapshot?.job) setJob(snapshot.job) }, [snapshot?.job])

  async function analyze() {
    if (!profile) return
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
    try {
      await coordinator?.stopObserving()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const heading = <div className="heading"><div><p className="kicker">PIPELINE</p><h1>Build your coach</h1>
    <p>Your games are analyzed by Stockfish right here in your browser. Anyone else studying the same player shares the work.</p></div></div>
  if (profile === undefined) return <section>{heading}<p className="muted">Loading…</p></section>
  if (profile === null) return <section>{heading}{error && <div className="error">{error}</div>}<p className="muted">Choose a player above to begin.</p></section>

  const current = snapshot?.job ?? job
  const active = Boolean(current && ACTIVE_JOB.has(current.status) && current.subscription_state === 'active' && snapshot?.state !== 'stopped')
  const succeeded = current?.status === 'succeeded' || snapshot?.state === 'succeeded'
  const total = current?.total_units ?? 0
  const saved = current?.completed_units ?? 0
  const local = snapshot?.localUnits ?? 0
  const analyzed = total > 0 && saved >= total
  const failed = snapshot?.state === 'failed'
  const readOnly = profile.state === 'read_only'
  const percent = total ? Math.min(100, Math.round(((saved + local) / total) * 100)) : 0
  const stage = (done: boolean, running: boolean): StageState => done ? 'done' : failed && running ? 'failed' : running ? 'running' : 'waiting'

  return <section>
    {heading}
    {error && <div className="error">{error}</div>}
    {!analysisEnabled && <div className="panel"><p className="muted">Analysis is not enabled yet. Existing results stay available on the other pages.</p></div>}
    {analysisEnabled && <div className="panel pipeline-controls">
      <div className="pipeline-actions">
        {active
          ? <button className="ghost" onClick={() => { void stop() }}>Stop following</button>
          : <button onClick={() => { void analyze() }} disabled={busy || readOnly || !capabilities}>
            {busy ? 'Syncing games…' : succeeded || profile.has_results ? 'Update with new games' : 'Analyze my games'}
          </button>}
        <label className="pipeline-toggle">
          <input type="checkbox" checked={computeAllowed} disabled={!capabilities?.supported || readOnly}
            onChange={(event) => { void toggleCompute(event.target.checked) }} />
          Use this device to analyze
        </label>
      </div>
      {capabilities && !capabilities.supported && <p className="muted" role="note">{capabilities.reason}</p>}
      {capabilities?.supported && !capabilities.recommended && capabilities.reason && <p className="muted pipeline-note">{capabilities.reason}</p>}
      {readOnly && <p className="muted">This player is read-only until your subscription is renewed. Existing results stay available.</p>}
      {snapshot?.state === 'stopped' && <p className="muted" role="status">You stopped following this analysis. Finished results stay available.</p>}
    </div>}
    <div className="list">
      <Stage name="Sync" detail={current ? `${total.toLocaleString()} Chess.com games` : 'Fetch your Chess.com games'} state={stage(Boolean(current), busy)} />
      <Stage name="Analyze" detail="Stockfish in your browser, resumable from checkpoints" state={stage(analyzed || succeeded, active && !analyzed)} />
      <Stage name="Build results" detail="Puzzles, coaching report, and mistake model" state={stage(succeeded, active && analyzed)} />
      <Stage name="Ready" detail="Practice, Mistakes, Progress, and the report use these results" state={succeeded ? 'done' : 'waiting'} />
    </div>
    {current && (active || failed) && <div className="panel">
      <h2>Live progress</h2>
      <p role="status">{workerText(snapshot, current)}</p>
      {snapshot?.resumed && snapshot.state === 'running' && <p className="muted pipeline-note">Resumed from the last saved checkpoint.</p>}
      <div className="pipeline-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={saved}><span style={{ width: `${percent}%` }} /></div>
      <div className="progress-grid">
        <div><span>games saved</span><b>{saved} / {total}</b></div>
        <div><span>analyzed here</span><b>{local}</b></div>
        <div><span>checkpoint</span><b>{current.checkpoint_sequence}</b></div>
        <div><span>worker</span><b>{current.worker_active ? (snapshot?.state === 'running' || snapshot?.state === 'uploading' ? 'This device' : 'Another browser') : 'None'}</b></div>
      </div>
    </div>}
    {succeeded && !active && <div className="panel"><p>Your results are ready. <NavLink to="/practice">Start practice</NavLink> or open the <NavLink to="/">Dashboard</NavLink>.</p>
      <p className="muted pipeline-note">Computed by players' browsers ("community computed"), not re-verified by the server.</p></div>}
  </section>
}
