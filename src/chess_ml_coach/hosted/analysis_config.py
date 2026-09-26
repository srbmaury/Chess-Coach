"""The server-authoritative configuration for browser-computed hosted analysis.

Everything that can change a result participates in the configuration hash: the
exact Stockfish WASM build, search depth, classification/scoring version, CPL
thresholds, and the versions of every derived stage. Browsers recompute this hash
from the published document and refuse to work on a mismatch.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from ..config import Settings
from ..engine import SCORING_VERSION
from .manifests import canonical_json

CONFIG_VERSION = "1"
# Stockfish.js 19.0.0 "lite single-threaded" build (npm `stockfish@19.0.0`, GPLv3).
ENGINE_BUILD: dict[str, str] = {
    "package": "stockfish",
    "version": "19.0.0",
    "flavor": "lite-single",
    "js_sha256": "d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6",
    "wasm_sha256": "57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387",
}
FEATURE_SCHEMA_VERSION = 1
PUZZLE_ALGORITHM_VERSION = 1
MODEL_ALGORITHM = "logistic-gd-v1"
REPORT_SCHEMA_VERSION = 1
BRILLIANT_MULTIPV = 2

ARTIFACT_TYPES = ("puzzles", "model_summary", "report")


def engine_build_hash() -> str:
    return sha256(canonical_json(ENGINE_BUILD)).hexdigest()


@dataclass(frozen=True)
class HostedAnalysisConfig:
    depth: int
    inaccuracy_cpl: int
    mistake_cpl: int
    blunder_cpl: int
    min_group_size: int

    @classmethod
    def from_settings(cls, settings: Settings) -> HostedAnalysisConfig:
        return cls(
            depth=settings.hosted_analysis_depth,
            inaccuracy_cpl=settings.thresholds.inaccuracy,
            mistake_cpl=settings.thresholds.mistake,
            blunder_cpl=settings.thresholds.blunder,
            min_group_size=settings.min_group_size,
        )

    def document(self) -> dict[str, object]:
        return {
            "config_version": CONFIG_VERSION,
            "engine": dict(ENGINE_BUILD),
            "depth": self.depth,
            "brilliant_multipv": BRILLIANT_MULTIPV,
            "scoring_version": SCORING_VERSION,
            "thresholds": {
                "inaccuracy": self.inaccuracy_cpl,
                "mistake": self.mistake_cpl,
                "blunder": self.blunder_cpl,
            },
            "min_group_size": self.min_group_size,
            "feature_schema": FEATURE_SCHEMA_VERSION,
            "puzzle_algorithm": PUZZLE_ALGORITHM_VERSION,
            "model_algorithm": MODEL_ALGORITHM,
            "report_schema": REPORT_SCHEMA_VERSION,
        }

    @property
    def hash(self) -> str:
        return sha256(canonical_json(self.document())).hexdigest()

    @property
    def engine_build_hash(self) -> str:
        return engine_build_hash()


def dependency_hash(
    *, analysis_config_hash: str, manifest_hash: str, checkpoint_hashes: list[str]
) -> str:
    """Identity of every derived artifact: config, input games, and ordered checkpoints."""
    return sha256(
        canonical_json(
            {
                "analysis_config_hash": analysis_config_hash,
                "manifest_hash": manifest_hash,
                "checkpoints": checkpoint_hashes,
            }
        )
    ).hexdigest()
