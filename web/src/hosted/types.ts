// Wire types for the hosted analysis API (see web/hosted_analysis_schemas.py).
export type JobStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

export type JobView = {
  id: string
  player_id: string
  status: JobStatus
  completed_units: number
  total_units: number
  checkpoint_sequence: number
  analysis_config_hash: string
  manifest_hash: string
  compute_source: string
  worker_active: boolean
  subscription_state: 'active' | 'stopped' | 'completed' | null
  can_compute: boolean
  updated_at: string
  finished_at: string | null
}

export type ProfileView = {
  id: string
  player_id: string
  username: string
  display_username: string
  slot_type: 'free' | 'paid'
  state: 'active' | 'read_only' | 'removed'
  can_compute: boolean
  latest_job: JobView | null
  has_results: boolean
}

export type ProfilesResponse = { analysis_enabled: boolean; profiles: ProfileView[] }

export type LeaseResponse = {
  lease_token: string
  expires_at: string
  lease_seconds: number
  renew_interval_seconds: number
  completed_units: number
  total_units: number
  checkpoint_sequence: number
}

export type ManifestResponse = {
  manifest_hash: string
  download_url: string
  expires_in: number
  total_units: number
  analysis_config_hash: string
  engine_build_hash: string
  analysis_config: Record<string, unknown> & { depth: number; min_group_size: number; brilliant_multipv: number }
}

export type UploadResponse = {
  storage_key: string
  upload_url: string | null
  content_type: string
  expires_at: string
  already_finalized: boolean
}

export type CheckpointView = {
  sequence: number
  content_hash: string
  byte_size: number
  result_count: number
  first_unit: number
  last_unit: number
  download_url?: string | null
}

export type ArtifactView = {
  artifact_type: 'puzzles' | 'model_summary' | 'report'
  dependency_hash: string
  schema_version: string
  content_hash: string
  byte_size: number
  compute_source: string
  analysis_config_hash: string | null
  created_at: string
  download_url?: string | null
}

export type ResultsResponse = { player_id: string; artifacts: ArtifactView[] }
