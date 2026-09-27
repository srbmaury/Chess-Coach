"""Authenticated coordination API for browser-computed shared analysis.

Routers stay thin: authentication, entitlement, rate limits, and error translation
happen here; every state transition lives in the hosted repositories/services.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, FastAPI, Path, Query, Request, Response
from fastapi.responses import JSONResponse

from ..chesscom import ChessComClient, ChessComError, ChessComNotFoundError
from ..hosted.analysis_config import MAX_DEPTH, MIN_DEPTH, HostedAnalysisConfig, engine_build_hash
from ..hosted.checkpoints import (
    CheckpointRejectedError,
    CheckpointService,
    IncompleteJobError,
    ManifestLoader,
    SequenceConflictError,
    UploadTooLargeError,
)
from ..hosted.jobs import JobError, JobNotFoundError, JobRepository, SharedJob
from ..hosted.leases import (
    InvalidDeviceError,
    LeaseError,
    LeaseLostError,
    LeaseService,
    LeaseUnavailableError,
    ObserverOnlyError,
)
from ..hosted.manifests import EmptyManifestError, GameManifest, ManifestError, ManifestService
from ..hosted.practice import PracticeRepository
from ..hosted.profiles import (
    InvalidUsernameError,
    NotEntitledError,
    PaidSubscriptionRequiredError,
    ProfileError,
    ProfileLimitError,
    ProfileRepository,
    UnknownPlayerError,
)
from ..hosted.rate_limit import InMemoryRateLimiter, RateLimitedError, RateLimiter
from ..hosted.storage import ArtifactStorage, ObjectNotFoundError, StorageError, SupabaseStorage
from ..hosted.sync import Runner, SyncBusyError, SyncService, _thread_runner
from .auth import require_account
from .hosted_analysis_schemas import (
    AnalysisCheckpointView,
    AnalysisRequest,
    AnalysisSetView,
    ArtifactFinalizeRequest,
    ArtifactUploadRequest,
    ArtifactView,
    CheckpointView,
    ComputePreferenceRequest,
    DeviceRequest,
    FinalizeCheckpointRequest,
    JobView,
    LeaseRequest,
    LeaseResponse,
    ManifestResponse,
    PipelineStateView,
    ProfileCreateRequest,
    ProfilesResponse,
    ProfileView,
    ResultView,
    SyncView,
    UploadRequest,
    UploadResponse,
)

if TYPE_CHECKING:
    from ..config import Settings
    from ..hosted.accounts import Account
    from ..hosted.database import Database

MAX_REQUEST_BYTES = 16 * 1024
SIGNED_DOWNLOAD_SECONDS = 300
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024

_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
JobId = Annotated[str, Path(pattern=_UUID)]
PlayerId = Annotated[str, Path(pattern=_UUID)]

router = APIRouter(prefix="/api/hosted")


@dataclass
class HostedAnalysisServices:
    enabled: bool
    config: HostedAnalysisConfig
    profiles: ProfileRepository
    jobs: JobRepository
    leases: LeaseService
    manifests: ManifestService
    manifest_loader: ManifestLoader
    checkpoints: CheckpointService
    storage: ArtifactStorage
    rate_limiter: RateLimiter
    practice: PracticeRepository
    sync: SyncService
    clock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    _config_ids: dict[int, str] = field(default_factory=dict)

    def config_for(self, depth: int | None = None) -> tuple[HostedAnalysisConfig, str]:
        """The shared analysis configuration for a Stockfish depth, and its database id."""
        config = self.config if depth is None else self.config.with_depth(depth)
        if config.depth not in self._config_ids:
            self._config_ids[config.depth] = self.jobs.ensure_config(config)
        return config, self._config_ids[config.depth]

    def config_id(self) -> str:
        return self.config_for()[1]


def build_hosted_analysis(
    settings: Settings,
    database: Database,
    *,
    storage: ArtifactStorage | None = None,
    chesscom: ChessComClient | None = None,
    rate_limiter: RateLimiter | None = None,
    sync_runner: Runner | None = None,
) -> HostedAnalysisServices | None:
    """Construct hosted analysis services, or ``None`` when Storage is not configured."""
    if storage is None:
        if not (settings.supabase_url and settings.supabase_secret_key):
            return None
        storage = SupabaseStorage(
            base_url=settings.supabase_url,
            secret_key=settings.supabase_secret_key,
            bucket=settings.supabase_storage_bucket,
        )
    client = chesscom or ChessComClient()
    loader = ManifestLoader(storage)
    profiles = ProfileRepository(database, player_lookup=client.player_profile)
    manifests = ManifestService(client, max_games=settings.hosted_max_games)
    return HostedAnalysisServices(
        enabled=settings.hosted_browser_analysis_enabled,
        config=HostedAnalysisConfig.from_settings(settings),
        profiles=profiles,
        jobs=JobRepository(database),
        leases=LeaseService(database),
        manifests=manifests,
        manifest_loader=loader,
        checkpoints=CheckpointService(
            database,
            storage,
            loader,
            max_upload_bytes=MAX_UPLOAD_BYTES,
            max_decompressed_bytes=MAX_DECOMPRESSED_BYTES,
        ),
        storage=storage,
        rate_limiter=rate_limiter or InMemoryRateLimiter(),
        practice=PracticeRepository(database),
        sync=SyncService(database, manifests, loader.store, profiles, runner=sync_runner or _thread_runner),
    )


# Errors ----------------------------------------------------------------------------


class HostedApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


_STATUS_BY_TYPE: tuple[tuple[type[Exception], int], ...] = (
    (InvalidUsernameError, 422),
    (UnknownPlayerError, 404),
    (PaidSubscriptionRequiredError, 402),
    (ProfileLimitError, 409),
    (NotEntitledError, 403),
    (ProfileError, 400),
    (JobNotFoundError, 404),
    (JobError, 409),
    (InvalidDeviceError, 422),
    (ObserverOnlyError, 403),
    (LeaseUnavailableError, 409),
    (LeaseLostError, 409),
    (LeaseError, 409),
    (UploadTooLargeError, 413),
    (SequenceConflictError, 409),
    (IncompleteJobError, 409),
    (CheckpointRejectedError, 422),
    (EmptyManifestError, 422),
    (ManifestError, 422),
    (RateLimitedError, 429),
    (SyncBusyError, 409),
    (ObjectNotFoundError, 404),
    (StorageError, 502),
    (ChessComNotFoundError, 404),
    (ChessComError, 502),
)
_PUBLIC_MESSAGES = {
    StorageError: "Result storage is temporarily unavailable",
    ChessComError: "Chess.com is temporarily unavailable",
}


def _translate(exc: Exception) -> HostedApiError:
    for kind, status in _STATUS_BY_TYPE:
        if isinstance(exc, kind):
            message = str(exc)
            for public_kind, public in _PUBLIC_MESSAGES.items():
                if isinstance(exc, public_kind) and not isinstance(exc, ChessComNotFoundError):
                    message = public
            return HostedApiError(status, getattr(exc, "code", "error"), message)
    raise exc


_DOMAIN_ERRORS = tuple(kind for kind, _ in _STATUS_BY_TYPE)


class _Guard:
    def __enter__(self):
        return self

    def __exit__(self, kind, exc, traceback):
        if exc is not None and isinstance(exc, _DOMAIN_ERRORS):
            raise _translate(exc) from None
        return False


def guarded() -> _Guard:
    return _Guard()


# Request plumbing ----------------------------------------------------------------------


class BodyLimitMiddleware:
    """Reject oversized hosted API bodies before they are buffered."""

    def __init__(self, app, *, max_bytes: int = MAX_REQUEST_BYTES, prefix: str = "/api/"):
        self.app = app
        self.max_bytes = max_bytes
        self.prefix = prefix

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(self.prefix):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(send)
            return
        # Bodies here are small JSON; read at most the limit plus one chunk, then replay.
        body = bytearray()
        more = True
        while more:
            message = await receive()
            if message["type"] != "http.request":
                break
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await self._reject(send)
                return
            more = message.get("more_body", False)
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send) -> None:
        response = JSONResponse(
            {"detail": "Request body is too large", "code": "body_too_large"}, status_code=413
        )
        await send({"type": "http.response.start", "status": 413, "headers": response.raw_headers})
        await send({"type": "http.response.body", "body": response.body})



def _services(request: Request, *, analysis: bool = True) -> HostedAnalysisServices:
    services = getattr(request.app.state, "hosted_analysis", None)
    if services is None:
        raise HostedApiError(503, "analysis_unavailable", "Hosted analysis is not configured")
    if analysis and not services.enabled:
        raise HostedApiError(503, "analysis_disabled", "Hosted analysis is not enabled yet")
    return services


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",", 1)[0].strip() or None
    return request.client.host if request.client else None


def _limit(services: HostedAnalysisServices, request: Request, action: str, account: Account):
    with guarded():
        services.rate_limiter.check(action, account_id=account.id, client_ip=_client_ip(request))


def _job_view(job: SharedJob) -> JobView:
    return JobView(
        id=job.id,
        player_id=job.player_id,
        status=job.status,
        completed_units=job.completed_work,
        total_units=job.total_work,
        checkpoint_sequence=job.checkpoint_sequence,
        analysis_config_hash=job.analysis_config_hash,
        manifest_hash=job.manifest_hash,
        compute_source=job.compute_source,
        worker_active=job.worker_active,
        subscription_state=job.subscription_state,
        can_compute=job.can_compute,
        updated_at=job.updated_at,
        finished_at=job.finished_at,
    )


def _entitled_job(
    services: HostedAnalysisServices, account: Account, job_id: str, *, write: bool
) -> SharedJob:
    with guarded():
        job = services.jobs.get(job_id, account.id)
        try:
            services.profiles.require_entitled(account.id, job.player_id, write=write)
        except NotEntitledError as exc:
            if not write:
                # Do not reveal that a job exists for a player you cannot see.
                raise JobNotFoundError("Analysis job not found") from exc
            raise
    return job


# Profiles --------------------------------------------------------------------------------


def _profile_views(services: HostedAnalysisServices, account: Account) -> list[ProfileView]:
    views = []
    config_id = services.config_id() if services.enabled else None
    for profile in services.profiles.list(account.id):
        latest = (
            services.jobs.latest_for_player(profile.player.id, config_id, account.id)
            if config_id
            else None
        )
        views.append(
            ProfileView(
                id=profile.id,
                player_id=profile.player.id,
                username=profile.player.canonical_username,
                display_username=profile.player.display_username,
                slot_type=profile.slot_type,
                state=profile.state,
                can_compute=profile.can_compute,
                latest_job=_job_view(latest) if latest else None,
                has_results=bool(services.checkpoints.ready_artifacts(profile.player.id)),
            )
        )
    return views


@router.get("/profiles", response_model=ProfilesResponse)
def list_profiles(request: Request) -> ProfilesResponse:
    account = require_account(request)
    services = _services(request, analysis=False)
    with guarded():
        return ProfilesResponse(
            analysis_enabled=services.enabled, profiles=_profile_views(services, account)
        )


@router.post("/profiles", response_model=ProfilesResponse, status_code=201)
def claim_profile(request: Request, body: ProfileCreateRequest) -> ProfilesResponse:
    account = require_account(request)
    services = _services(request, analysis=False)
    _limit(services, request, "profile", account)
    with guarded():
        services.profiles.claim(account.id, body.username)
        return ProfilesResponse(
            analysis_enabled=services.enabled, profiles=_profile_views(services, account)
        )


# Jobs -----------------------------------------------------------------------------------


@router.get("/jobs/{job_id}", response_model=JobView)
def get_job(request: Request, job_id: JobId) -> JobView:
    account = require_account(request)
    services = _services(request)
    return _job_view(_entitled_job(services, account, job_id, write=False))


@router.post("/jobs/{job_id}/subscribe", response_model=JobView)
def subscribe(request: Request, job_id: JobId, body: ComputePreferenceRequest) -> JobView:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "join", account)
    job = _entitled_job(services, account, job_id, write=True)
    if job.terminal:
        return _job_view(job)
    with guarded():
        return _job_view(services.jobs.subscribe(job_id, account.id, body.can_compute))


@router.post("/jobs/{job_id}/stop", response_model=JobView)
def stop_observing(request: Request, job_id: JobId) -> JobView:
    account = require_account(request)
    services = _services(request)
    _entitled_job(services, account, job_id, write=False)
    with guarded():
        return _job_view(services.jobs.stop_observing(job_id, account.id))


@router.post("/jobs/{job_id}/compute", response_model=JobView)
def set_compute(request: Request, job_id: JobId, body: ComputePreferenceRequest) -> JobView:
    account = require_account(request)
    services = _services(request)
    _entitled_job(services, account, job_id, write=body.can_compute)
    with guarded():
        return _job_view(services.jobs.set_can_compute(job_id, account.id, body.can_compute))


# Leases ------------------------------------------------------------------------------


def _lease_response(grant) -> LeaseResponse:
    return LeaseResponse(
        lease_token=grant.token,
        expires_at=grant.expires_at,
        lease_seconds=grant.lease_seconds,
        renew_interval_seconds=grant.renew_interval_seconds,
        completed_units=grant.completed_work,
        total_units=grant.total_work,
        checkpoint_sequence=grant.checkpoint_sequence,
    )


@router.post("/jobs/{job_id}/lease/claim", response_model=LeaseResponse)
def claim_lease(request: Request, job_id: JobId, body: DeviceRequest) -> LeaseResponse:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "claim", account)
    _entitled_job(services, account, job_id, write=True)
    with guarded():
        return _lease_response(services.leases.claim(job_id, account.id, body.device_id))


@router.post("/jobs/{job_id}/lease/renew", response_model=LeaseResponse)
def renew_lease(request: Request, job_id: JobId, body: LeaseRequest) -> LeaseResponse:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "renew", account)
    _entitled_job(services, account, job_id, write=True)
    with guarded():
        grant = services.leases.renew(job_id, account.id, body.device_id, body.lease_token)
    return _lease_response(grant)


@router.post("/jobs/{job_id}/lease/release", status_code=204)
def release_lease(request: Request, job_id: JobId, body: LeaseRequest) -> Response:
    account = require_account(request)
    services = _services(request)
    _entitled_job(services, account, job_id, write=False)
    with guarded():
        services.leases.release(job_id, account.id, body.device_id, body.lease_token)
    return Response(status_code=204)


@router.get("/jobs/{job_id}/manifest", response_model=ManifestResponse)
def job_manifest(request: Request, job_id: JobId, response: Response) -> ManifestResponse:
    account = require_account(request)
    services = _services(request)
    job = _entitled_job(services, account, job_id, write=True)
    if job.subscription_state != "active":
        raise HostedApiError(403, "not_subscribed", "Subscribe to this analysis first")
    with guarded():
        url = services.storage.signed_download_url(
            job.manifest_storage_key, expires_in=SIGNED_DOWNLOAD_SECONDS
        )
    with guarded():
        document = services.jobs.config_document(job.analysis_config_hash)
        units = services.jobs.unit_game_ids(job.id)
    response.headers["ETag"] = f'"{job.manifest_hash}"'
    response.headers["Cache-Control"] = "private, no-store"
    return ManifestResponse(
        manifest_hash=job.manifest_hash,
        download_url=url,
        expires_in=SIGNED_DOWNLOAD_SECONDS,
        total_units=job.total_work,
        units=units,
        analysis_config_hash=job.analysis_config_hash,
        engine_build_hash=engine_build_hash(),
        analysis_config=document,
    )


# Uploads, checkpoints, artifacts, completion ------------------------------------------------


@router.post("/jobs/{job_id}/uploads", response_model=UploadResponse)
def create_upload(request: Request, job_id: JobId, body: UploadRequest) -> UploadResponse:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "upload", account)
    _entitled_job(services, account, job_id, write=True)
    with guarded():
        if body.sequence is None:
            raise CheckpointRejectedError("Checkpoint uploads need a sequence")
        grant = services.checkpoints.create_checkpoint_upload(
            job_id, account.id, body.device_id, body.lease_token,
            sequence=body.sequence, byte_size=body.byte_size, content_hash=body.content_hash,
        )
    return UploadResponse(
        storage_key=grant.upload.storage_key,
        upload_url=grant.upload.url or None,
        content_type=grant.upload.content_type,
        expires_at=grant.expires_at,
        already_finalized=grant.already_finalized,
    )


@router.post("/jobs/{job_id}/checkpoints/finalize", response_model=CheckpointView)
def finalize_checkpoint(
    request: Request, job_id: JobId, body: FinalizeCheckpointRequest
) -> CheckpointView:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "finalize", account)
    _entitled_job(services, account, job_id, write=True)
    with guarded():
        checkpoint = services.checkpoints.finalize_checkpoint(
            job_id, account.id, body.device_id, body.lease_token,
            sequence=body.sequence, content_hash=body.content_hash,
        )
    return CheckpointView(
        sequence=checkpoint.sequence,
        content_hash=checkpoint.content_hash,
        byte_size=checkpoint.byte_size,
        result_count=checkpoint.result_count,
        first_unit=checkpoint.first_unit,
        last_unit=checkpoint.last_unit,
    )



# Player pipeline: the classic Pipeline page's stages in hosted mode ----------------------

Depth = Annotated[int, Query(ge=MIN_DEPTH, le=MAX_DEPTH)]


def _player(services: HostedAnalysisServices, account: Account, player_id: str, *, write: bool):
    with guarded():
        return services.profiles.require_entitled(account.id, player_id, write=write)


def _manifest(services: HostedAnalysisServices, player) -> GameManifest:
    if not player.latest_manifest_hash:
        raise HostedApiError(409, "not_synced", "Run Sync first to fetch your Chess.com games")
    with guarded():
        return services.manifest_loader.load(player.id, player.latest_manifest_key, player.latest_manifest_hash)


def _config(services: HostedAnalysisServices, depth: int | None):
    try:
        return services.config_for(depth)
    except ValueError as exc:
        raise HostedApiError(422, "invalid_depth", str(exc)) from exc


def _sync_view(state) -> SyncView:
    return SyncView(
        status=state.status, started_at=state.started_at, finished_at=state.finished_at,
        error=state.error, current=state.progress.get("current"), total=state.progress.get("total"),
        game_count=state.game_count, synced_at=state.synced_at,
    )


@router.get("/players/{player_id}/pipeline", response_model=PipelineStateView)
def player_pipeline(request: Request, player_id: PlayerId, depth: Depth | None = None) -> PipelineStateView:
    account = require_account(request)
    services = _services(request, analysis=False)
    player = _player(services, account, player_id, write=False)
    config, config_id = _config(services, depth)
    analyzed = None
    if player.latest_manifest_hash:
        manifest = _manifest(services, player)
        analyzed = services.checkpoints.analysis_set(player.id, config_id, config.hash, manifest)
    job = services.jobs.latest_for_player(player.id, config_id, account.id)
    results = {
        item.artifact_type: ResultView(created_at=item.created_at, dependency_hash=item.dependency_hash)
        for item in services.checkpoints.ready_artifacts(player.id)
    }
    return PipelineStateView(
        player_id=player.id,
        depth=config.depth,
        default_depth=services.config.depth,
        analysis_enabled=services.enabled,
        analysis_config_hash=config.hash,
        sync=_sync_view(services.sync.state(player.id)),
        total_games=analyzed.total_games if analyzed else 0,
        analyzed_games=analyzed.analyzed_games if analyzed else 0,
        analyzed_moves=analyzed.analyzed_moves if analyzed else 0,
        dependency_hash=analyzed.dependency_hash if analyzed and analyzed.analyzed_games else None,
        job=_job_view(job) if job else None,
        results=results,
    )


@router.post("/players/{player_id}/sync", response_model=SyncView, status_code=202)
def start_sync(request: Request, player_id: PlayerId) -> SyncView:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "join", account)
    player = _player(services, account, player_id, write=True)
    with guarded():
        return _sync_view(services.sync.start(player))


@router.post("/players/{player_id}/analysis", response_model=JobView)
def start_analysis(request: Request, player_id: PlayerId, body: AnalysisRequest) -> JobView:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "join", account)
    player = _player(services, account, player_id, write=True)
    config, config_id = _config(services, body.depth)
    if services.jobs.config_quarantined(config.hash):
        raise HostedApiError(503, "config_quarantined", "Hosted analysis is paused")
    manifest = _manifest(services, player)
    with guarded():
        job = services.jobs.create_or_join(
            account_id=account.id,
            player_id=player.id,
            config_id=config_id,
            engine_build_hash=config.engine_build_hash,
            manifest_hash=manifest.hash,
            manifest_storage_key=manifest.storage_key,
            game_ids=[game.game_id for game in manifest.games],
            can_compute=body.can_compute,
        )
    return _job_view(job)


@router.get("/players/{player_id}/analysis-set", response_model=AnalysisSetView)
def analysis_set(request: Request, player_id: PlayerId, depth: Depth | None = None) -> AnalysisSetView:
    account = require_account(request)
    services = _services(request)
    player = _player(services, account, player_id, write=False)
    config, config_id = _config(services, depth)
    manifest = _manifest(services, player)
    with guarded():
        found = services.checkpoints.analysis_set(player.id, config_id, config.hash, manifest)
        manifest_url = services.storage.signed_download_url(manifest.storage_key, expires_in=SIGNED_DOWNLOAD_SECONDS)
        checkpoints = [
            AnalysisCheckpointView(
                content_hash=ref.content_hash,
                game_ids=ref.game_ids,
                download_url=services.storage.signed_download_url(ref.storage_key, expires_in=SIGNED_DOWNLOAD_SECONDS),
            )
            for ref in found.checkpoints
        ]
    return AnalysisSetView(
        manifest_hash=manifest.hash,
        manifest_url=manifest_url,
        analysis_config_hash=config.hash,
        analysis_config=config.document(),
        total_games=found.total_games,
        analyzed_games=found.analyzed_games,
        analyzed_moves=found.analyzed_moves,
        dependency_hash=found.dependency_hash,
        checkpoints=checkpoints,
    )


@router.post("/players/{player_id}/artifacts/uploads", response_model=UploadResponse)
def create_artifact_upload(request: Request, player_id: PlayerId, body: ArtifactUploadRequest) -> UploadResponse:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "upload", account)
    player = _player(services, account, player_id, write=True)
    config, config_id = _config(services, body.depth)
    manifest = _manifest(services, player)
    with guarded():
        grant = services.checkpoints.create_artifact_upload(
            player_id=player.id, account_id=account.id, config_id=config_id, config_hash=config.hash,
            manifest_hash=manifest.hash, artifact_type=body.artifact_type,
            checkpoint_hashes=body.checkpoint_hashes, byte_size=body.byte_size,
            content_hash=body.content_hash,
        )
    return UploadResponse(
        storage_key=grant.upload.storage_key,
        upload_url=grant.upload.url or None,
        content_type=grant.upload.content_type,
        expires_at=grant.expires_at,
        already_finalized=grant.already_finalized,
    )


@router.post("/players/{player_id}/artifacts/finalize", response_model=ArtifactView)
def finalize_artifact(request: Request, player_id: PlayerId, body: ArtifactFinalizeRequest) -> ArtifactView:
    account = require_account(request)
    services = _services(request)
    _limit(services, request, "finalize", account)
    player = _player(services, account, player_id, write=True)
    config, config_id = _config(services, body.depth)
    manifest = _manifest(services, player)
    with guarded():
        artifact = services.checkpoints.finalize_artifact(
            player_id=player.id, config_id=config_id, config_hash=config.hash, manifest=manifest,
            artifact_type=body.artifact_type, checkpoint_hashes=body.checkpoint_hashes,
            content_hash=body.content_hash,
        )
    return ArtifactView(
        artifact_type=artifact.artifact_type,
        dependency_hash=artifact.dependency_hash,
        schema_version=artifact.schema_version,
        content_hash=artifact.content_hash,
        byte_size=artifact.byte_size,
        compute_source=artifact.compute_source,
        analysis_config_hash=artifact.analysis_config_hash,
        created_at=artifact.created_at,
    )


def install_hosted_analysis(app: FastAPI, services: HostedAnalysisServices | None) -> None:
    app.state.hosted_analysis = services
    app.add_middleware(BodyLimitMiddleware)
    app.include_router(router)

    @app.exception_handler(HostedApiError)
    async def _hosted_error(_request: Request, exc: HostedApiError) -> JSONResponse:
        return JSONResponse({"detail": exc.message, "code": exc.code}, status_code=exc.status_code)
