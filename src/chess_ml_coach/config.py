import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

PersistenceMode = Literal["local", "hosted"]


def _persistence_mode(value: str) -> PersistenceMode:
    normalized = value.strip().lower()
    if normalized not in {"local", "hosted"}:
        raise ValueError("Persistence mode must be 'local' or 'hosted'")
    return cast(PersistenceMode, normalized)


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


@dataclass(frozen=True)
class MoveQualityThresholds:
    inaccuracy: int = 50
    mistake: int = 100
    blunder: int = 200

    def __post_init__(self) -> None:
        if not 0 <= self.inaccuracy < self.mistake < self.blunder:
            raise ValueError("CPL thresholds must satisfy 0 <= inaccuracy < mistake < blunder")


@dataclass(frozen=True)
class Settings:
    username: str = "srbmaury"
    data_dir: Path = Path("data")
    model_dir: Path = Path("models")
    profile_lock_path: Path | None = None
    stockfish_path: str | None = None
    stockfish_depth: int = 14
    min_group_size: int = 10
    thresholds: MoveQualityThresholds = field(default_factory=MoveQualityThresholds)
    persistence_mode: PersistenceMode = "local"
    database_url: str | None = None
    supabase_jwt_secret: str | None = None
    supabase_jwt_audience: str = "authenticated"
    supabase_url: str | None = None
    supabase_publishable_key: str | None = None
    hosted_browser_analysis_enabled: bool = False

    def __post_init__(self) -> None:
        if self.persistence_mode == "hosted" and not self.database_url:
            raise ValueError("DATABASE_URL is required in hosted persistence mode")
        if self.is_hosted and self.supabase_url:
            try:
                parsed = urlsplit(self.supabase_url)
                _ = parsed.port
            except ValueError:
                # Parser errors echo the input, which may contain a misplaced credential.
                raise ValueError(
                    "SUPABASE_URL must be an HTTPS origin without credentials"
                ) from None
            if not (
                parsed.scheme == "https"
                and parsed.hostname
                and not parsed.username
                and not parsed.password
                and not parsed.query
                and not parsed.fragment
                and parsed.path in {"", "/"}
            ):
                raise ValueError("SUPABASE_URL must be an HTTPS origin without credentials")
        if (
            self.is_hosted
            and self.supabase_publishable_key
            and not (
                self.supabase_publishable_key.startswith("sb_publishable_")
                and len(self.supabase_publishable_key) > len("sb_publishable_")
            )
        ):
            raise ValueError("SUPABASE_PUBLISHABLE_KEY must be a publishable key")
        if (
            self.is_hosted
            and self.hosted_browser_analysis_enabled
            and not (
                self.supabase_url and self.supabase_url.strip() and self.supabase_publishable_key
            )
        ):
            raise ValueError(
                "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for hosted browser analysis"
            )

    @property
    def is_hosted(self) -> bool:
        return self.persistence_mode == "hosted"


def get_settings(
    username: str | None = None,
    *,
    data_dir: Path | None = None,
    model_dir: Path | None = None,
    stockfish_path: str | None = None,
    stockfish_depth: int | None = None,
    min_group_size: int | None = None,
    inaccuracy_cpl: int | None = None,
    mistake_cpl: int | None = None,
    blunder_cpl: int | None = None,
    persistence_mode: PersistenceMode | None = None,
    database_url: str | None = None,
    supabase_jwt_secret: str | None = None,
    supabase_jwt_audience: str | None = None,
    supabase_url: str | None = None,
    supabase_publishable_key: str | None = None,
    hosted_browser_analysis_enabled: bool | None = None,
) -> Settings:
    thresholds = MoveQualityThresholds(
        inaccuracy=(
            inaccuracy_cpl
            if inaccuracy_cpl is not None
            else int(os.getenv("CHESS_COACH_INACCURACY_CPL", "50"))
        ),
        mistake=(
            mistake_cpl
            if mistake_cpl is not None
            else int(os.getenv("CHESS_COACH_MISTAKE_CPL", "100"))
        ),
        blunder=(
            blunder_cpl
            if blunder_cpl is not None
            else int(os.getenv("CHESS_COACH_BLUNDER_CPL", "200"))
        ),
    )
    return Settings(
        username=username or os.getenv("CHESS_COACH_USERNAME", "srbmaury"),
        data_dir=data_dir or Path(os.getenv("CHESS_COACH_DATA_DIR", "data")),
        model_dir=model_dir or Path(os.getenv("CHESS_COACH_MODEL_DIR", "models")),
        stockfish_path=(
            stockfish_path if stockfish_path is not None else os.getenv("STOCKFISH_PATH")
        ),
        stockfish_depth=(
            stockfish_depth
            if stockfish_depth is not None
            else int(os.getenv("CHESS_COACH_STOCKFISH_DEPTH", "14"))
        ),
        min_group_size=(
            min_group_size
            if min_group_size is not None
            else int(os.getenv("CHESS_COACH_MIN_GROUP_SIZE", "10"))
        ),
        thresholds=thresholds,
        persistence_mode=(
            persistence_mode
            if persistence_mode is not None
            else _persistence_mode(os.getenv("CHESS_COACH_PERSISTENCE_MODE", "local"))
        ),
        database_url=(
            database_url if database_url is not None else os.getenv("DATABASE_URL") or None
        ),
        supabase_jwt_secret=(
            supabase_jwt_secret
            if supabase_jwt_secret is not None
            else os.getenv("SUPABASE_JWT_SECRET") or None
        ),
        supabase_jwt_audience=(
            supabase_jwt_audience
            if supabase_jwt_audience is not None
            else os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated")
        ),
        supabase_url=(
            supabase_url if supabase_url is not None else os.getenv("SUPABASE_URL") or None
        ),
        supabase_publishable_key=(
            supabase_publishable_key
            if supabase_publishable_key is not None
            else os.getenv("SUPABASE_PUBLISHABLE_KEY") or None
        ),
        hosted_browser_analysis_enabled=(
            hosted_browser_analysis_enabled
            if hosted_browser_analysis_enabled is not None
            else _env_flag("CHESS_COACH_HOSTED_BROWSER_ANALYSIS_ENABLED")
        ),
    )
