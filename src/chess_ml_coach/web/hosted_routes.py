from __future__ import annotations

from fastapi import APIRouter, Request

from .auth import require_account
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
        lease_seconds=60,
        renew_interval_seconds=20,
        max_upload_bytes=8 * 1024 * 1024,
        max_decompressed_bytes=32 * 1024 * 1024,
        max_browser_cache_bytes=256 * 1024 * 1024,
    )


@router.get("/api/hosted/account/me")
def whoami(request: Request) -> dict[str, object]:
    account = require_account(request)
    return {"id": account.id, "email": account.email}
