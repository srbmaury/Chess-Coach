// The hosted Pipeline: the same stages, status, and events as the local server's
// /api/pipeline/*, driven from this tab. Sync runs on the server; Analyze runs
// Stockfish here (resumable from checkpoints and shared with anyone studying the same
// player); Features, Puzzles, Train, and Report build from whatever games are analyzed
// so far and publish their results. It lives for the whole signed-in session, so
// changing pages never interrupts a stage, and a reload picks a running one back up.
import type { AnalysisRow, ManifestGame } from '../analysis/classify'
import { canonicalJson, sha256Hex } from '../analysis/hash'
import type { ArtifactType, DeriveInput, DeriveResult } from '../analysis/pipeline'
import { downloadSigned, HostedApiError, putSigned, type HostedApi } from './api'
import type { Capabilities } from './device'
import { gunzip, gunzipJson, gzipJson } from './encoding'
import type { CoordinatorLike } from './services'
import type { AnalysisSetView, JobView } from './types'

export const PIPELINE_STAGES = ['sync', 'analyze', 'features', 'puzzles', 'train', 'report'] as const
export type PipelineStage = typeof PIPELINE_STAGES[number]

export type PipelineStatus = {
  stage: string | null
  status: 'idle' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled'
  username: string | null
  started_at: string | null
  finished_at: string | null
  result: Record<string, unknown> | null
  error: string | null
}

export type PipelineEvent = Record<string, unknown> & { sequence: number; created_at: string; stage: string; status: string }

/** An HTTP-shaped failure, so the transport can answer like the local server does. */
export class PipelineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export type PipelineDeps = {
  api: Pick<HostedApi, 'profiles' | 'pipeline' | 'sync' | 'analyze' | 'analysisSet' | 'uploadArtifact' | 'finalizeArtifact'>
  /** The classic player bar's active Chess.com username. */
  activeUsername: () => Promise<string | null>
  createCoordinator: (computeAllowed: boolean) => Promise<CoordinatorLike>
  capabilities: () => Promise<Capabilities>
  derive: (input: DeriveInput, only: readonly ArtifactType[]) => Promise<DeriveResult>
  defaultDepth: number
  limits: { maxUploadBytes: number; maxDecompressedBytes: number }
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  pollMs?: number
  putSigned?: typeof putSigned
  downloadSigned?: typeof downloadSigned
}

type Player = { id: string; username: string }
type Context = {
  player: Player
  depth: number
  progress: (payload: Record<string, unknown>) => void
  /** Called by stop(); an analysis run registers how to stop itself. */
  onStop: (handler: () => Promise<void>) => void
  live: () => boolean
}

class Cancelled extends Error {}

const ACTIVE_JOB = new Set(['queued', 'running', 'paused'])
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024
const DEPTH_KEY = 'chess-coach-analysis-depth'
const ARTIFACTS: Record<'puzzles' | 'train' | 'report', ArtifactType> = { puzzles: 'puzzles', train: 'model_summary', report: 'report' }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class HostedPipeline {
  private snapshot: PipelineStatus = {
    stage: null, status: 'idle', username: null, started_at: null, finished_at: null, result: null, error: null,
  }
  private readonly listeners = new Set<(event: PipelineEvent) => void>()
  private sequence = 0
  private generation = 0
  private stopHandler: (() => Promise<void>) | null = null
  private players = new Map<string, Player>()
  private analysis: { key: string; input: DeriveInput; hashes: string[] } | null = null
  private depthValue: number

  constructor(private readonly deps: PipelineDeps) {
    const stored = Number(this.storage()?.getItem(DEPTH_KEY))
    this.depthValue = Number.isInteger(stored) && stored >= 1 && stored <= 20 ? stored : deps.defaultDepth
  }

  /** The Stockfish depth to show: the last one analyzed with, else the server's default. */
  get depth(): number {
    return this.depthValue
  }

  status(): PipelineStatus {
    return this.snapshot
  }

  subscribe(listener: (event: PipelineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.generation += 1
    void this.stopHandler?.().catch(() => undefined)
    this.stopHandler = null
    this.listeners.clear()
  }

  /** Pick up a sync or analysis that was running before this page loaded. */
  async resume(): Promise<void> {
    if (this.busy()) return
    let player: Player
    try {
      player = await this.activePlayer()
    } catch {
      return
    }
    const state = await this.deps.api.pipeline(player.id, this.depthValue).catch(() => null)
    if (!state || this.busy()) return
    if (state.sync.status === 'running') {
      this.launch('sync', player, this.depthValue, (context) => this.runSync(context, true))
    } else if (state.job && ACTIVE_JOB.has(state.job.status) && state.job.subscription_state === 'active') {
      const job = state.job
      this.launch('analyze', player, state.depth, (context) => this.runAnalysis(context, job))
    }
  }

  async start(stage: string, options: Record<string, unknown> = {}): Promise<PipelineStatus> {
    if (stage === 'stop') return this.stop()
    if (!(PIPELINE_STAGES as readonly string[]).includes(stage)) throw new PipelineError(`Unknown pipeline stage: ${stage}`, 404)
    if (this.busy()) throw new PipelineError(`Pipeline job '${this.snapshot.stage}' is already running`, 409)
    const depth = options.depth === undefined || options.depth === null ? this.depthValue : Number(options.depth)
    if (!Number.isInteger(depth) || depth < 1 || depth > 20) throw new PipelineError('Stockfish depth must be between 1 and 20', 422)
    let player: Player
    try {
      player = await this.activePlayer()
    } catch (error) {
      throw new PipelineError((error as Error).message, 409)
    }
    if (this.busy()) throw new PipelineError(`Pipeline job '${this.snapshot.stage}' is already running`, 409)
    if (stage === 'analyze') this.rememberDepth(depth)
    const runner = stage === 'sync' ? (context: Context) => this.runSync(context, false)
      : stage === 'analyze' ? (context: Context) => this.runAnalysis(context, null)
        : (context: Context) => this.runDerived(context, stage as Exclude<PipelineStage, 'sync' | 'analyze'>)
    this.launch(stage, player, depth, runner)
    return this.snapshot
  }

  async stop(): Promise<PipelineStatus> {
    if (this.snapshot.status === 'stopping') return this.snapshot
    if (this.snapshot.status !== 'running') throw new PipelineError('No pipeline job is currently running', 409)
    if (this.snapshot.stage !== 'analyze') throw new PipelineError('Only Stockfish analysis can be stopped safely', 422)
    this.snapshot = { ...this.snapshot, status: 'stopping' }
    this.emit({ stage: 'analyze', status: 'stopping', username: this.snapshot.username ?? '' })
    const handler = this.stopHandler
    if (handler) void handler().catch(() => undefined)
    return this.snapshot
  }

  // Runs -----------------------------------------------------------------------------------

  private busy(): boolean {
    return this.snapshot.status === 'running' || this.snapshot.status === 'stopping'
  }

  private launch(stage: string, player: Player, depth: number, runner: (context: Context) => Promise<Record<string, unknown>>): void {
    const generation = ++this.generation
    this.stopHandler = null
    const startedAt = new Date().toISOString()
    this.snapshot = {
      stage, status: 'running', username: player.username, started_at: startedAt, finished_at: null, result: null, error: null,
    }
    this.emit({ stage, status: 'running', username: player.username })
    let last = ''
    const context: Context = {
      player,
      depth,
      live: () => generation === this.generation && this.snapshot.status === 'running',
      onStop: (handler) => {
        if (generation !== this.generation) return
        this.stopHandler = handler
        // Stop pressed while the run was still getting ready.
        if (this.snapshot.status === 'stopping') void handler().catch(() => undefined)
      },
      progress: (payload) => {
        const key = JSON.stringify(payload)
        if (generation !== this.generation || key === last) return
        last = key
        this.emit({ ...payload, stage, status: this.snapshot.status === 'stopping' ? 'stopping' : 'running' })
      },
    }
    void runner(context).then(
      (result) => this.finish(generation, stage, 'succeeded', result, null),
      (error: unknown) => {
        if (error instanceof Cancelled || this.snapshot.status === 'stopping') this.finish(generation, stage, 'cancelled', null, null)
        else this.finish(generation, stage, 'failed', null, error instanceof Error ? error.message : 'Pipeline stage failed')
      },
    )
  }

  private finish(generation: number, stage: string, status: 'succeeded' | 'failed' | 'cancelled',
    result: Record<string, unknown> | null, error: string | null): void {
    if (generation !== this.generation) return
    this.stopHandler = null
    this.snapshot = { ...this.snapshot, status, finished_at: new Date().toISOString(), result, error }
    this.emit({ ...(result ?? {}), stage, status, ...(error ? { error } : {}) })
  }

  private emit(payload: Record<string, unknown> & { stage: string; status: string }): void {
    this.sequence += 1
    const event = { sequence: this.sequence, created_at: new Date().toISOString(), ...payload }
    this.listeners.forEach((listener) => listener(event))
  }

  private async runSync(context: Context, attached: boolean): Promise<Record<string, unknown>> {
    if (!attached) {
      try {
        await this.deps.api.sync(context.player.id)
      } catch (error) {
        if (!(error instanceof HostedApiError && error.code === 'sync_running')) throw error
      }
    }
    for (;;) {
      const state = await this.deps.api.pipeline(context.player.id, context.depth)
      if (!context.live()) throw new Cancelled()
      const sync = state.sync
      if (sync.status === 'running') {
        context.progress(sync.total ? { current_month: sync.current ?? 0, total_months: sync.total } : { phase: 'starting' })
      } else if (sync.status === 'failed') {
        throw new Error(sync.error ?? 'Sync failed; try again')
      } else {
        return { total_games: state.total_games, analyzed_games: state.analyzed_games }
      }
      await sleep(this.deps.pollMs ?? 1000)
    }
  }

  private async runAnalysis(context: Context, existing: JobView | null): Promise<Record<string, unknown>> {
    const capabilities = await this.deps.capabilities()
    if (!capabilities.supported) throw new Error(capabilities.reason ?? 'This browser cannot run the analysis engine')
    const job = existing ?? await this.deps.api.analyze(context.player.id, context.depth, true)
    if (!context.live()) throw new Cancelled()
    if (job.status !== 'succeeded') await this.follow(context, job)
    const state = await this.deps.api.pipeline(context.player.id, context.depth)
    return {
      depth: context.depth,
      analyzed_games: state.analyzed_games,
      total_games: state.total_games,
      analyzed_moves: state.analyzed_moves,
    }
  }

  /** Analyze (or watch another browser analyze) until the job finishes or is stopped. */
  private async follow(context: Context, job: JobView): Promise<void> {
    const coordinator = await this.deps.createCoordinator(true)
    if (!context.live()) {
      coordinator.dispose()
      throw new Cancelled()
    }
    let unsubscribe: () => void = () => undefined
    try {
      await new Promise<void>((resolve, reject) => {
        context.onStop(async () => {
          await coordinator.stopObserving()
          reject(new Cancelled())
        })
        unsubscribe = coordinator.subscribe((snapshot) => {
          const current = snapshot.job ?? job
          const here = snapshot.state === 'running' || snapshot.state === 'uploading'
          context.progress({
            completed_games: current.completed_units + snapshot.localUnits,
            total_games: current.total_units,
            checkpoint: current.checkpoint_sequence,
            worker: here ? 'this browser' : current.worker_active ? 'another browser' : 'waiting',
            ...(snapshot.message ? { note: snapshot.message } : {}),
          })
          if (snapshot.state === 'succeeded') resolve()
          else if (snapshot.state === 'failed') reject(new Error(snapshot.message ?? 'Analysis stopped'))
          else if (snapshot.state === 'stopped') reject(new Cancelled())
        })
        coordinator.start(job.id).catch(reject)
      })
    } finally {
      unsubscribe()
      coordinator.dispose()
    }
  }

  private async runDerived(context: Context, stage: Exclude<PipelineStage, 'sync' | 'analyze'>): Promise<Record<string, unknown>> {
    const { input, hashes } = await this.loadAnalysis(context)
    context.progress({ phase: stage === 'features' ? 'building features' : 'building results', analyzed_games: input.games.length })
    const type = stage === 'features' ? null : ARTIFACTS[stage]
    const derived = await this.deps.derive(input, type ? [type] : [])
    if (!context.live()) throw new Cancelled()
    if (!type) return { feature_rows: derived.featureRows, analyzed_games: input.games.length }
    const artifact = derived.artifacts[type]!
    context.progress({ phase: 'publishing', analyzed_games: input.games.length })
    const bytes = await gzipJson(artifact)
    if (bytes.byteLength > this.deps.limits.maxUploadBytes) throw new Error('The results are larger than the upload limit')
    const body = { depth: context.depth, artifact_type: type, content_hash: await sha256Hex(bytes), checkpoint_hashes: hashes }
    const upload = await this.deps.api.uploadArtifact(context.player.id, { ...body, byte_size: bytes.byteLength })
    if (!upload.already_finalized && upload.upload_url) {
      await (this.deps.putSigned ?? putSigned)(upload.upload_url, bytes, upload.content_type)
    }
    await this.deps.api.finalizeArtifact(context.player.id, body)
    if (type === 'puzzles') return { eligible_puzzles: derived.artifacts.puzzles!.puzzles.length, feature_rows: derived.featureRows }
    if (type === 'model_summary') {
      const model = derived.artifacts.model_summary!
      return model.status === 'trained'
        ? { model_status: 'trained', train_rows: model.train_rows, test_rows: model.test_rows, roc_auc: model.metrics.roc_auc }
        : { model_status: model.status, reason: model.reason }
    }
    return { samples: derived.artifacts.report!.overall.samples, feature_rows: derived.featureRows }
  }

  /** Download this player's analyzed games (verified), reusing the last set if unchanged. */
  private async loadAnalysis(context: Context): Promise<{ input: DeriveInput; hashes: string[] }> {
    const set: AnalysisSetView = await this.deps.api.analysisSet(context.player.id, context.depth)
    if (!set.analyzed_games) throw new Error(`No games are analyzed at depth ${context.depth} yet; run Analyze first`)
    const hashes = set.checkpoints.map((checkpoint) => checkpoint.content_hash)
    const dependency = await sha256Hex(canonicalJson({
      analysis_config_hash: set.analysis_config_hash, manifest_hash: set.manifest_hash, checkpoints: [...hashes].sort(),
    }))
    if (dependency !== set.dependency_hash) throw new Error('The analyzed games changed while loading; run the stage again')
    const key = `${context.player.id}:${set.dependency_hash}`
    if (this.analysis?.key === key) return this.analysis
    const download = this.deps.downloadSigned ?? downloadSigned
    const manifestBody = await gunzip(await download(set.manifest_url, MANIFEST_MAX_BYTES), MANIFEST_MAX_BYTES)
    if (await sha256Hex(manifestBody) !== set.manifest_hash) throw new Error('The game list failed its integrity check')
    const allGames = (JSON.parse(new TextDecoder().decode(manifestBody)) as { games: ManifestGame[] }).games
    const analysis = new Map<string, AnalysisRow[]>()
    for (const [index, checkpoint] of set.checkpoints.entries()) {
      context.progress({ phase: 'downloading analysis', checkpoints: `${index + 1} / ${set.checkpoints.length}` })
      const bytes = await download(checkpoint.download_url, this.deps.limits.maxUploadBytes)
      if (await sha256Hex(bytes) !== checkpoint.content_hash) throw new Error('A checkpoint failed its integrity check')
      const payload = await gunzipJson<{ games: { game_id: string; rows: AnalysisRow[] }[] }>(bytes, this.deps.limits.maxDecompressedBytes)
      const wanted = new Set(checkpoint.game_ids)
      payload.games.forEach((game) => { if (wanted.has(game.game_id)) analysis.set(game.game_id, game.rows) })
      if (!context.live()) throw new Cancelled()
    }
    const input: DeriveInput = {
      games: allGames.filter((game) => analysis.has(game.game_id)),
      analysis,
      minGroupSize: Number(set.analysis_config.min_group_size),
      dependencyHash: set.dependency_hash,
      analysisConfigHash: set.analysis_config_hash,
    }
    this.analysis = { key, input, hashes }
    return this.analysis
  }

  // Helpers --------------------------------------------------------------------------------

  private async activePlayer(): Promise<Player> {
    const username = await this.deps.activeUsername()
    if (!username) throw new Error('Choose a player first')
    const cached = this.players.get(username)
    if (cached) return cached
    const { profiles } = await this.deps.api.profiles()
    const profile = profiles.find((item) => item.username === username)
    if (!profile) throw new Error('Choose a player first')
    const player = { id: profile.player_id, username: profile.username }
    this.players.set(username, player)
    return player
  }

  private rememberDepth(depth: number): void {
    this.depthValue = depth
    try { this.storage()?.setItem(DEPTH_KEY, String(depth)) } catch { /* optional */ }
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (this.deps.storage !== undefined) return this.deps.storage
    try { return globalThis.localStorage ?? null } catch { return null }
  }
}

/** Answer the classic Pipeline page's /api/pipeline/* requests from the driver. */
export function pipelineRoutes(pipeline: HostedPipeline) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  return async (path: string, init?: RequestInit): Promise<Response | null> => {
    const pathname = path.split('?')[0]
    const method = (init?.method ?? 'GET').toUpperCase()
    if (pathname === '/api/pipeline/status' && method === 'GET') return json(200, pipeline.status())
    const match = method === 'POST' ? pathname.match(/^\/api\/pipeline\/([a-z]+)$/) : null
    if (!match) return null
    try {
      const options = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) as Record<string, unknown> : {}
      return json(202, await pipeline.start(match[1], options))
    } catch (error) {
      if (error instanceof PipelineError) return json(error.status, { detail: error.message })
      return json(500, { detail: 'Pipeline request failed' })
    }
  }
}
