from __future__ import annotations

from fastapi import APIRouter, Request

from ..hosted.analysis_config import HostedAnalysisConfig
from ..hosted.leases import LEASE_SECONDS, RENEW_INTERVAL_SECONDS
from .auth import require_account
from .hosted_analysis_routes import MAX_DECOMPRESSED_BYTES, MAX_UPLOAD_BYTES
from .schemas import HostedBrowserConfig

router = APIRouter()


@router.get(
    "/api/hosted/config", response_model=HostedBrowserConfig, response_model_exclude_unset=True
)
def browser_config(request: Request) -> HostedBrowserConfig:
    settings = request.app.state.settings
    if not settings.is_hosted:
        return HostedBrowserConfig(hosted=False)
    return HostedBrowserConfig(
        hosted=True,
        supabase_url=settings.supabase_url,
        supabase_publishable_key=settings.supabase_publishable_key,
        analysis_enabled=settings.hosted_browser_analysis_enabled,
        engine_version="19.0.0",
        config_version="1",
        analysis_config_hash=HostedAnalysisConfig.from_settings(settings).hash,
        lease_seconds=LEASE_SECONDS,
        renew_interval_seconds=RENEW_INTERVAL_SECONDS,
        max_upload_bytes=MAX_UPLOAD_BYTES,
        max_decompressed_bytes=MAX_DECOMPRESSED_BYTES,
        max_browser_cache_bytes=256 * 1024 * 1024,
    )


@router.get("/api/hosted/account/me")
def whoami(request: Request) -> dict[str, object]:
    account = require_account(request)
    return {"id": account.id, "email": account.email}
