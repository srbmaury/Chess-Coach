import { FormEvent, useEffect, useState } from 'react'
import { apiFetch } from './apiTransport'
import type { HostedEnvironment } from './hostedContext'

type Profile = { username: string; display_username: string }
type ProfileList = { active_username: string | null; profiles: Profile[] }
type PipelineStatus = { stage?: string | null; status?: string; username?: string | null }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try { const body = await response.json(); message = body.detail || message } catch { /* keep status message */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

type Props = {
  /** Hosted mode: an account bar with sign-out; analysis lives on the Pipeline page. */
  hosted?: HostedEnvironment | null
  onProfileChanged: () => void
  onActiveProfileChanged?: (username: string | null) => void
}

export default function CommunityControls({ hosted = null, onProfileChanged, onActiveProfileChanged }: Props) {
  const [profiles, setProfiles] = useState<ProfileList | null>(null)
  const [username, setUsername] = useState('')
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refreshProfiles() {
    try {
      const data = await request<ProfileList>('/api/profiles')
      if (Array.isArray(data.profiles)) {
        setProfiles(data)
        onActiveProfileChanged?.(data.active_username)
      }
    } catch { /* optional on older/dev API */ }
  }

  async function refreshPipeline() {
    try { setPipeline(await request<PipelineStatus>('/api/pipeline/status')) } catch { /* supplemental */ }
  }

  useEffect(() => {
    void refreshProfiles()
    void refreshPipeline()
    const timer = window.setInterval(() => { void refreshPipeline() }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function activate(next: string) {
    if (!next || next === profiles?.active_username) return
    setBusy(true); setError('')
    try {
      const data = await request<ProfileList>(`/api/profiles/${encodeURIComponent(next)}/activate`, { method: 'POST' })
      setProfiles(data)
      onActiveProfileChanged?.(data.active_username)
      onProfileChanged()
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  async function addPlayer(event: FormEvent) {
    event.preventDefault()
    const next = username.trim(); if (!next) return
    setBusy(true); setError('')
    try {
      await request('/api/profiles', { method: 'POST', body: JSON.stringify({ username: next, activate: true }) })
      setUsername('')
      await refreshProfiles()
      onProfileChanged()
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  async function stopAnalysis() {
    setBusy(true); setError('')
    try { setPipeline(await request<PipelineStatus>('/api/pipeline/stop', { method: 'POST' })) }
    catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  if (!profiles) return null

  if (!profiles.active_username) {
    return <section style={{maxWidth:560,margin:'12vh auto',padding:'0 20px'}}>
      <div className="panel">
        <p className="kicker">GET STARTED</p>
        <h1>Choose your Chess.com player</h1>
        <p className="muted">Enter a Chess.com username. Games, analysis, puzzles, and progress stay isolated to that player.</p>
        <form onSubmit={addPlayer} style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <input aria-label="Chess.com username" autoFocus placeholder="Chess.com username" value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
          <button type="submit" disabled={busy || !username.trim()}>{busy ? 'Opening…' : 'Continue'}</button>
        </form>
        {error && <span style={{color:'#ff9a9a',fontSize:13}}>{error}</span>}
        {hosted && <span style={{marginTop:16,display:'flex',gap:10,alignItems:'center'}}><small className="muted">{hosted.email}</small><button className="ghost" onClick={hosted.signOut}>Sign out</button></span>}
      </div>
    </section>
  }

  const pipelineBusy = ['running', 'stopping'].includes(pipeline?.status || '')
  const analysisActive = pipelineBusy && pipeline?.stage === 'analyze'
  return <div style={{position:'sticky',top:0,zIndex:30,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',padding:'10px 16px',background:'#171a14',borderBottom:'1px solid #2b3026'}}>
    <strong>Player</strong>
    <select aria-label="Active Chess.com player" value={profiles.active_username} disabled={busy || pipelineBusy} onChange={(event) => { void activate(event.target.value) }}>
      {profiles.profiles.map((profile) => <option key={profile.username} value={profile.username}>{profile.display_username}</option>)}
    </select>
    <form onSubmit={addPlayer} style={{display:'flex',gap:8}}>
      <input aria-label="Chess.com username" placeholder="Chess.com username" value={username} disabled={busy || pipelineBusy} onChange={(event) => setUsername(event.target.value)} />
      <button type="submit" disabled={busy || pipelineBusy}>Add player</button>
    </form>
    {analysisActive && <button className="ghost" disabled={busy || pipeline?.status === 'stopping'} onClick={() => { void stopAnalysis() }}>{pipeline?.status === 'stopping' ? 'Stopping analysis…' : 'Stop analysis'}</button>}
    {error && <span style={{color:'#ff9a9a',fontSize:13}}>{error}</span>}
    {hosted && <span style={{marginLeft:'auto',display:'flex',gap:10,alignItems:'center'}}><small className="muted">{hosted.email}</small><button className="ghost" onClick={hosted.signOut}>Sign out</button></span>}
  </div>
}
