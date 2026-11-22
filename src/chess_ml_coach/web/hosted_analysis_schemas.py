from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DeviceId = Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")
LeaseToken = Field(min_length=16, max_length=128)
ContentHash = Field(pattern=r"^[0-9a-f]{64}$")
ArtifactType = Literal["puzzles", "model_summary", "report"]


class StrictRequest(BaseModel):
    """Requests never accept identity, ownership, or status fields from the client."""

    model_config = ConfigDict(extra="forbid")


class ProfileCreateRequest(StrictRequest):
    username: str = Field(min_length=1, max_length=40)


class JobView(BaseModel):
    id: str
    player_id: str
    status: str
    completed_units: int
    total_units: int
    checkpoint_sequence: int
    analysis_config_hash: str
    manifest_hash: str
    compute_source: str
    worker_active: bool
    subscription_state: str | None
    can_compute: bool
    updated_at: datetime
    finished_at: datetime | None


class ProfileView(BaseModel):
    id: str
    player_id: str
    username: str
    display_username: str
    slot_type: str
    state: str
    can_compute: bool
    latest_job: JobView | None
    has_results: bool


class ProfilesResponse(BaseModel):
    analysis_enabled: bool
    profiles: list[ProfileView]


class ComputePreferenceRequest(StrictRequest):
    can_compute: bool


class DeviceRequest(StrictRequest):
    device_id: str = DeviceId


class LeaseRequest(StrictRequest):
    device_id: str = DeviceId
    lease_token: str = LeaseToken


class LeaseResponse(BaseModel):
    lease_token: str
    expires_at: datetime
    lease_seconds: int
    renew_interval_seconds: int
    completed_units: int
    total_units: int
    checkpoint_sequence: int


class ManifestResponse(BaseModel):
    manifest_hash: str
    download_url: str
    expires_in: int
    total_units: int
    units: list[str]
    analysis_config_hash: str
    engine_build_hash: str
    analysis_config: dict[str, object]


class UploadRequest(StrictRequest):
    device_id: str = DeviceId
    lease_token: str = LeaseToken
    kind: Literal["checkpoint"] = "checkpoint"
    sequence: int | None = Field(default=None, ge=1)
    byte_size: int = Field(ge=1)
    content_hash: str = ContentHash


class UploadResponse(BaseModel):
    storage_key: str
    upload_url: str | None
    content_type: str
    expires_at: datetime
    already_finalized: bool


class FinalizeCheckpointRequest(StrictRequest):
    device_id: str = DeviceId
    lease_token: str = LeaseToken
    sequence: int = Field(ge=1)
    content_hash: str = ContentHash


class CheckpointView(BaseModel):
    sequence: int
    content_hash: str
    byte_size: int
    result_count: int
    first_unit: int
    last_unit: int
    download_url: str | None = None


class ArtifactView(BaseModel):
    artifact_type: str
    dependency_hash: str
    schema_version: str
    content_hash: str
    byte_size: int
    compute_source: str
    analysis_config_hash: str | None
    created_at: datetime
    download_url: str | None = None


class SyncView(BaseModel):
    status: Literal["idle", "running", "succeeded", "failed"]
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    current: int | None
    total: int | None
    game_count: int | None
    synced_at: datetime | None


class ResultView(BaseModel):
    created_at: datetime
    dependency_hash: str


class PipelineStateView(BaseModel):
    player_id: str
    depth: int
    default_depth: int
    analysis_enabled: bool
    analysis_config_hash: str
    sync: SyncView
    total_games: int
    analyzed_games: int
    analyzed_moves: int
    dependency_hash: str | None
    job: JobView | None
    results: dict[str, ResultView]


class AnalysisRequest(StrictRequest):
    depth: int | None = Field(default=None, ge=1, le=20)
    can_compute: bool = True


class AnalysisCheckpointView(BaseModel):
    content_hash: str
    game_ids: list[str]
    download_url: str


class AnalysisSetView(BaseModel):
    manifest_hash: str
    manifest_url: str
    analysis_config_hash: str
    analysis_config: dict[str, object]
    total_games: int
    analyzed_games: int
    analyzed_moves: int
    dependency_hash: str
    checkpoints: list[AnalysisCheckpointView]


class ArtifactFinalizeRequest(StrictRequest):
    depth: int | None = Field(default=None, ge=1, le=20)
    artifact_type: ArtifactType
    content_hash: str = ContentHash
    checkpoint_hashes: list[str] = Field(min_length=1, max_length=5000)


class ArtifactUploadRequest(ArtifactFinalizeRequest):
    byte_size: int = Field(ge=1)
