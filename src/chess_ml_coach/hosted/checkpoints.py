"""Checkpoint and derived-artifact finalization for browser-computed analysis.

A browser uploads immutable, gzip-compressed JSON directly to Storage, then asks to
finalize it. Finalization proves lease ownership, re-reads the object within strict
compressed/decompressed bounds, checks its hash and every structural invariant
against the canonical manifest, and only then records it and advances progress in
one transaction. Engine evaluations themselves cannot be verified without repeating
the search, so results are labelled ``community_computed``.
"""

from __future__ import annotations

import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from hmac import compare_digest

from psycopg.types.json import Jsonb

from .analysis_config import ARTIFACT_TYPES, dependency_hash
from .checkpoint_validation import (
    ARTIFACT_SCHEMA_VERSION,
    CheckpointRejectedError,
    UploadTooLargeError,
    bounded_gunzip,
    validate_artifact_payload,
    validate_checkpoint_payload,
)
from .database import Database
from .jobs import clear_lease
from .leases import LeaseLostError, token_digest, verify_lease
from .manifests import GameManifest, ManifestGame, parse_manifest_bytes
from .practice import PracticeRepository
from .storage import ArtifactStorage, ObjectNotFoundError, SignedUpload

UPLOAD_GRANT_SECONDS = 300
CLOCK_SKEW = timedelta(seconds=30)
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class SequenceConflictError(CheckpointRejectedError):
    code = "sequence_conflict"


class IncompleteJobError(CheckpointRejectedError):
    code = "incomplete_job"


@dataclass(frozen=True)
class Checkpoint:
    job_id: str
    sequence: int
    storage_key: str
    byte_size: int
    content_hash: str
    result_count: int
    first_unit: int
    last_unit: int


@dataclass(frozen=True)
class Artifact:
    id: str
    player_id: str
    job_id: str | None
    artifact_type: str
    dependency_hash: str
    schema_version: str
    storage_key: str
    content_hash: str
    byte_size: int
    compute_source: str
    analysis_config_hash: str | None
    created_at: datetime


@dataclass(frozen=True)
class CheckpointRef:
    content_hash: str
    storage_key: str
    game_ids: list[str]


@dataclass(frozen=True)
class AnalysisSet:
    manifest_hash: str
    total_games: int
    analyzed_games: int
    analyzed_moves: int
    checkpoints: list[CheckpointRef]
    dependency_hash: str


@dataclass(frozen=True)
class UploadGrant:
    upload: SignedUpload
    expires_at: datetime
    already_finalized: bool = False


def checkpoint_storage_key(job_id: str, config_hash: str, sequence: int, content_hash: str) -> str:
    return f"jobs/{job_id}/checkpoints/{config_hash[:16]}/{sequence:08d}-{content_hash}.json.gz"


def artifact_storage_key(
    player_id: str, artifact_type: str, dependency: str, content_hash: str
) -> str:
    return f"players/{player_id}/artifacts/{artifact_type}/{dependency}-{content_hash}.json.gz"


class ManifestLoader:
    """Loads canonical manifests from Storage, verifying their hash, with a small LRU."""

    def __init__(self, storage: ArtifactStorage, *, capacity: int = 4):
        self._storage = storage
        self._capacity = capacity
        self._cache: OrderedDict[str, GameManifest] = OrderedDict()

    def load(self, player_id: str, storage_key: str, manifest_hash: str) -> GameManifest:
        cached = self._cache.get(manifest_hash)
        if cached is not None:
            self._cache.move_to_end(manifest_hash)
            return cached
        stored = self._storage.get(storage_key, max_bytes=MAX_MANIFEST_BYTES)
        try:
            body = bounded_gunzip(stored.body, MAX_MANIFEST_BYTES)
        except CheckpointRejectedError as exc:
            raise RuntimeError("Stored manifest is corrupt") from exc
        if sha256(body).hexdigest() != manifest_hash:
            raise RuntimeError("Stored manifest does not match its hash")
        manifest = parse_manifest_bytes(player_id, body)
        self._cache[manifest_hash] = manifest
        while len(self._cache) > self._capacity:
            self._cache.popitem(last=False)
        return manifest

    def store(self, manifest: GameManifest) -> None:
        self._storage.put(manifest.storage_key, manifest.compressed())
        self._cache[manifest.hash] = manifest
        while len(self._cache) > self._capacity:
            self._cache.popitem(last=False)


_ARTIFACT_COLUMNS = (
    "id, player_id, job_id, artifact_type, dependency_hash, schema_version, storage_key, "
    "content_hash, byte_size, compute_source, analysis_config_hash, created_at"
)


def _artifact(row) -> Artifact:
    return Artifact(
        id=str(row[0]),
        player_id=str(row[1]),
        job_id=str(row[2]) if row[2] else None,
        artifact_type=row[3],
        dependency_hash=row[4],
        schema_version=row[5],
        storage_key=row[6],
        content_hash=row[7],
        byte_size=row[8],
        compute_source=row[9],
        analysis_config_hash=row[10],
        created_at=row[11],
    )


def _checkpoint(row) -> Checkpoint:
    return Checkpoint(
        job_id=str(row[0]),
        sequence=row[1],
        storage_key=row[2],
        byte_size=row[3],
        content_hash=row[4],
        result_count=row[5],
        first_unit=row[6],
        last_unit=row[7],
    )


_CHECKPOINT_COLUMNS = (
    "job_id, sequence, storage_key, byte_size, content_hash, result_count, first_unit, last_unit"
)


class CheckpointService:
    def __init__(
        self,
        database: Database,
        storage: ArtifactStorage,
        manifests: ManifestLoader,
        *,
        max_upload_bytes: int,
        max_decompressed_bytes: int,
    ):
        self._database = database
        self._storage = storage
        self._manifests = manifests
        self._max_upload = max_upload_bytes
        self._max_decompressed = max_decompressed_bytes

    # Uploads ---------------------------------------------------------------------

    def _grant(
        self,
        connection,
        *,
        account_id: str,
        purpose: str,
        key: str,
        byte_size: int,
        content_hash: str,
        job_id: str | None = None,
        lease_digest: str | None = None,
        player_id: str | None = None,
        sequence: int | None = None,
        artifact_type: str | None = None,
    ) -> datetime:
        row = connection.execute(
            "INSERT INTO analysis_upload_grants (job_id, player_id, account_id, purpose, sequence, "
            "artifact_type, storage_bucket, storage_key, byte_size, content_hash, "
            "lease_token_digest, expires_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
            "now() + make_interval(secs => %s)) "
            "ON CONFLICT (storage_key) DO UPDATE SET expires_at = excluded.expires_at, "
            "lease_token_digest = excluded.lease_token_digest, account_id = excluded.account_id "
            "WHERE analysis_upload_grants.consumed_at IS NULL "
            "AND analysis_upload_grants.byte_size = excluded.byte_size "
            "RETURNING expires_at",
            (
                job_id, player_id, account_id, purpose, sequence, artifact_type,
                self._storage.bucket, key, byte_size, content_hash, lease_digest,
                UPLOAD_GRANT_SECONDS,
            ),
        ).fetchone()
        if row is None:
            raise SequenceConflictError("This object was already uploaded with different metadata")
        return row[0]

    def _check_upload_size(self, byte_size: int, content_hash: str) -> None:
        if (
            not isinstance(byte_size, int)
            or isinstance(byte_size, bool)
            or not 0 < byte_size <= self._max_upload
        ):
            raise UploadTooLargeError("Upload exceeds the size limit")
        if not isinstance(content_hash, str) or not _HEX64.fullmatch(content_hash):
            raise CheckpointRejectedError("Invalid content hash")

    def create_checkpoint_upload(
        self, job_id: str, account_id: str, device_id: str, token: str, *,
        sequence: int, byte_size: int, content_hash: str,
    ) -> UploadGrant:
        self._check_upload_size(byte_size, content_hash)
        with self._database.transaction() as connection:
            lease = verify_lease(connection, job_id, account_id, device_id, token)
            existing = connection.execute(
                "SELECT content_hash FROM analysis_checkpoints WHERE job_id = %s AND sequence = %s",
                (job_id, sequence),
            ).fetchone()
            key = checkpoint_storage_key(job_id, lease.analysis_config_hash, sequence, content_hash)
            if existing:
                if existing[0] != content_hash:
                    raise SequenceConflictError("That checkpoint sequence is already recorded")
                return UploadGrant(SignedUpload(key, ""), datetime.now().astimezone(), True)
            if sequence != lease.checkpoint_sequence + 1:
                raise SequenceConflictError("Unexpected checkpoint sequence")
            if lease.completed_work >= lease.total_work:
                raise SequenceConflictError("Every game is already analyzed")
            expires_at = self._grant(
                connection, account_id=account_id, purpose="checkpoint", key=key,
                byte_size=byte_size, content_hash=content_hash, job_id=job_id,
                lease_digest=lease.token_digest, sequence=sequence,
            )
        return UploadGrant(self._storage.create_upload(key), expires_at)

    def _fetch_verified(self, key: str, byte_size: int, content_hash: str, expires_at: datetime):
        try:
            stored = self._storage.get(key, max_bytes=self._max_upload)
        except ObjectNotFoundError:
            raise CheckpointRejectedError("The upload has not arrived in Storage") from None
        if len(stored.body) != byte_size:
            raise CheckpointRejectedError("Uploaded size does not match the declared size")
        if sha256(stored.body).hexdigest() != content_hash:
            raise CheckpointRejectedError("Uploaded content does not match its hash")
        if stored.last_modified is not None and stored.last_modified > expires_at + CLOCK_SKEW:
            raise CheckpointRejectedError("The upload arrived after its grant expired")
        body = bounded_gunzip(stored.body, self._max_decompressed)
        try:
            return json.loads(body)
        except ValueError:
            raise CheckpointRejectedError("Upload is not valid JSON") from None

    def _pending_grant(self, connection, key: str, content_hash: str, *, job_id: str | None = None,
                       player_id: str | None = None):
        row = connection.execute(
            "SELECT byte_size, expires_at, consumed_at FROM analysis_upload_grants "
            "WHERE storage_key = %s AND content_hash = %s "
            "AND job_id IS NOT DISTINCT FROM %s AND player_id IS NOT DISTINCT FROM %s",
            (key, content_hash, job_id, player_id),
        ).fetchone()
        if row is None:
            raise CheckpointRejectedError("No upload was granted for this object")
        return row

    @staticmethod
    def _find_finalized_checkpoint(connection, job_id: str, sequence: int):
        return connection.execute(
            f"SELECT {_CHECKPOINT_COLUMNS} FROM analysis_checkpoints "
            "WHERE job_id = %s AND sequence = %s",
            (job_id, sequence),
        ).fetchone()

    def _verify_checkpoint_finalization(
        self, connection, job_id: str, account_id: str, device_id: str, token: str,
        sequence: int, content_hash: str,
    ):
        try:
            lease = verify_lease(connection, job_id, account_id, device_id, token)
        except LeaseLostError:
            # The final commit clears the lease. Only the original uploader with the
            # consumed grant's token may recover the receipt for that exact commit.
            grant = connection.execute(
                "SELECT g.lease_token_digest FROM analysis_checkpoints c "
                "JOIN analysis_jobs j ON j.id = c.job_id "
                "JOIN analysis_upload_grants g ON g.storage_key = c.storage_key "
                "WHERE j.id = %s AND j.status = 'succeeded' AND j.checkpoint_sequence = %s "
                "AND c.sequence = j.checkpoint_sequence AND c.content_hash = %s "
                "AND c.uploader_account_id = %s AND c.uploader_device_id = %s "
                "AND g.consumed_at IS NOT NULL",
                (job_id, sequence, content_hash, account_id, device_id),
            ).fetchone()
            if grant is None or not grant[0] or not token or not compare_digest(
                grant[0], token_digest(token)
            ):
                raise
            return None, self._find_finalized_checkpoint(connection, job_id, sequence)

        existing = self._find_finalized_checkpoint(connection, job_id, sequence)
        if existing is not None and existing[4] != content_hash:
            raise SequenceConflictError("That checkpoint sequence is already recorded")
        return lease, existing

    def finalize_checkpoint(
        self, job_id: str, account_id: str, device_id: str, token: str, *,
        sequence: int, content_hash: str,
    ) -> Checkpoint:
        with self._database.transaction() as connection:
            lease, existing = self._verify_checkpoint_finalization(
                connection, job_id, account_id, device_id, token, sequence, content_hash
            )
            if existing is not None:
                return _checkpoint(existing)
            assert lease is not None
            if sequence != lease.checkpoint_sequence + 1:
                raise SequenceConflictError("Unexpected checkpoint sequence")
            key = checkpoint_storage_key(job_id, lease.analysis_config_hash, sequence, content_hash)
            byte_size, expires_at, _ = self._pending_grant(connection, key, content_hash, job_id=job_id)
            first_unit = lease.completed_work
        # Storage reads happen outside the row lock; ownership is re-proven below.
        payload = self._fetch_verified(key, byte_size, content_hash, expires_at)
        manifest = self._manifests.load(
            lease.player_id, lease.manifest_storage_key, lease.manifest_hash
        )
        units = self.job_units(job_id, manifest)
        first, last, results = validate_checkpoint_payload(
            payload, units, job_id=job_id, sequence=sequence, first_unit=first_unit,
            config_hash=lease.analysis_config_hash, engine_hash=lease.engine_build_hash,
        )
        with self._database.transaction() as connection:
            current, existing = self._verify_checkpoint_finalization(
                connection, job_id, account_id, device_id, token, sequence, content_hash
            )
            if existing is not None:
                return _checkpoint(existing)
            assert current is not None
            if current.checkpoint_sequence + 1 != sequence or current.completed_work != first:
                raise SequenceConflictError("Checkpoint cursor moved while validating")
            row = connection.execute(
                "INSERT INTO analysis_checkpoints (job_id, sequence, storage_bucket, storage_key, "
                "byte_size, content_hash, result_count, first_unit, last_unit, first_game_id, "
                "last_game_id, analysis_config_hash, engine_build_hash, uploader_account_id, "
                "uploader_device_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                f"%s, %s, %s) RETURNING {_CHECKPOINT_COLUMNS}",
                (
                    job_id, sequence, self._storage.bucket, key, byte_size, content_hash, results,
                    first, last, units[first].game_id, units[last].game_id,
                    current.analysis_config_hash, current.engine_build_hash, account_id, device_id,
                ),
            ).fetchone()
            config_id = connection.execute(
                "SELECT analysis_config_id FROM analysis_jobs WHERE id = %s", (job_id,)
            ).fetchone()[0]
            checkpoint_id = connection.execute(
                "SELECT id FROM analysis_checkpoints WHERE job_id = %s AND sequence = %s",
                (job_id, sequence),
            ).fetchone()[0]
            # Keep analysis per game; a game another job recorded first keeps that record.
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO analyzed_games (player_id, analysis_config_id, game_id, "
                    "checkpoint_id, move_count) VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                    [
                        (current.player_id, config_id, entry["game_id"], checkpoint_id, len(entry["rows"]))
                        for entry in payload["games"]
                    ],
                )
            finished = last + 1 >= current.total_work
            connection.execute(
                "UPDATE analysis_jobs SET completed_work = %s, checkpoint_sequence = %s, "
                "checkpoint_hash = %s, checkpoint_manifest_key = %s, "
                "stage = CASE WHEN %s THEN 'complete' ELSE 'analyze' END, "
                "status = CASE WHEN %s THEN 'succeeded' ELSE status END, "
                "finished_at = CASE WHEN %s THEN now() ELSE finished_at END "
                "WHERE id = %s",
                (last + 1, sequence, content_hash, key, finished, finished, finished, job_id),
            )
            if finished:
                clear_lease(connection, job_id)
                connection.execute(
                    "UPDATE job_subscribers SET state = 'completed' WHERE job_id = %s "
                    "AND state = 'active'",
                    (job_id,),
                )
            connection.execute(
                "UPDATE analysis_upload_grants SET consumed_at = now(), lease_token_digest = %s "
                "WHERE storage_key = %s",
                (current.token_digest, key),
            )
        return _checkpoint(row)

    def job_units(self, job_id: str, manifest: GameManifest) -> list[ManifestGame]:
        by_id = {game.game_id: game for game in manifest.games}
        with self._database.transaction() as connection:
            ids = [
                row[0]
                for row in connection.execute(
                    "SELECT game_id FROM job_units WHERE job_id = %s ORDER BY unit_index", (job_id,)
                ).fetchall()
            ]
        return [by_id[game_id] for game_id in ids]

    # Results (puzzles, model, report) --------------------------------------------------

    def analysis_set(self, player_id: str, config_id: str, config_hash: str,
                     manifest: GameManifest) -> AnalysisSet:
        """The analyzed games of the current game list, grouped by the checkpoint holding them."""
        wanted = {game.game_id for game in manifest.games}
        with self._database.transaction() as connection:
            rows = connection.execute(
                "SELECT ag.game_id, ag.move_count, c.content_hash, c.storage_key "
                "FROM analyzed_games ag JOIN analysis_checkpoints c ON c.id = ag.checkpoint_id "
                "WHERE ag.player_id = %s AND ag.analysis_config_id = %s",
                (player_id, config_id),
            ).fetchall()
        groups: dict[str, CheckpointRef] = {}
        moves = 0
        for game_id, move_count, content_hash, storage_key in rows:
            if game_id not in wanted:
                continue
            moves += move_count
            ref = groups.setdefault(content_hash, CheckpointRef(content_hash, storage_key, []))
            ref.game_ids.append(game_id)
        refs = sorted(groups.values(), key=lambda ref: ref.content_hash)
        return AnalysisSet(
            manifest_hash=manifest.hash,
            total_games=len(manifest.games),
            analyzed_games=sum(len(ref.game_ids) for ref in refs),
            analyzed_moves=moves,
            checkpoints=refs,
            dependency_hash=dependency_hash(
                analysis_config_hash=config_hash, manifest_hash=manifest.hash,
                checkpoint_hashes=[ref.content_hash for ref in refs],
            ),
        )

    @staticmethod
    def _verified_dependency(connection, player_id: str, config_id: str, config_hash: str,
                             manifest_hash: str, checkpoint_hashes: list[str]) -> tuple[str, int]:
        """Prove the cited checkpoints hold this player's analysis; return (dependency, moves)."""
        cited = sorted(set(checkpoint_hashes))
        if not cited or len(cited) != len(checkpoint_hashes):
            raise CheckpointRejectedError("Cite each analyzed checkpoint exactly once")
        rows = connection.execute(
            "SELECT c.content_hash, sum(ag.move_count) FROM analyzed_games ag "
            "JOIN analysis_checkpoints c ON c.id = ag.checkpoint_id "
            "WHERE ag.player_id = %s AND ag.analysis_config_id = %s AND c.content_hash = ANY(%s) "
            "GROUP BY c.content_hash",
            (player_id, config_id, cited),
        ).fetchall()
        if len(rows) != len(cited):
            raise CheckpointRejectedError("Results must be built from this player's analysis")
        dependency = dependency_hash(
            analysis_config_hash=config_hash, manifest_hash=manifest_hash, checkpoint_hashes=cited
        )
        return dependency, sum(int(row[1]) for row in rows)

    def create_artifact_upload(
        self, *, player_id: str, account_id: str, config_id: str, config_hash: str,
        manifest_hash: str, artifact_type: str, checkpoint_hashes: list[str], byte_size: int,
        content_hash: str,
    ) -> UploadGrant:
        if artifact_type not in ARTIFACT_TYPES:
            raise CheckpointRejectedError("Unknown artifact type")
        self._check_upload_size(byte_size, content_hash)
        with self._database.transaction() as connection:
            dependency, _ = self._verified_dependency(
                connection, player_id, config_id, config_hash, manifest_hash, checkpoint_hashes
            )
            key = artifact_storage_key(player_id, artifact_type, dependency, content_hash)
            ready = connection.execute(
                "SELECT 1 FROM derived_artifacts WHERE storage_key = %s AND status = 'ready'",
                (key,),
            ).fetchone()
            if ready:
                return UploadGrant(SignedUpload(key, ""), datetime.now().astimezone(), True)
            expires_at = self._grant(
                connection, account_id=account_id, purpose="artifact", key=key,
                byte_size=byte_size, content_hash=content_hash, player_id=player_id,
                artifact_type=artifact_type,
            )
        return UploadGrant(self._storage.create_upload(key), expires_at)

    def finalize_artifact(
        self, *, player_id: str, config_id: str, config_hash: str, manifest: GameManifest,
        artifact_type: str, checkpoint_hashes: list[str], content_hash: str,
    ) -> Artifact:
        if artifact_type not in ARTIFACT_TYPES:
            raise CheckpointRejectedError("Unknown artifact type")
        with self._database.transaction() as connection:
            dependency, moves = self._verified_dependency(
                connection, player_id, config_id, config_hash, manifest.hash, checkpoint_hashes
            )
            key = artifact_storage_key(player_id, artifact_type, dependency, content_hash)
            existing = connection.execute(
                f"SELECT {_ARTIFACT_COLUMNS} FROM derived_artifacts "
                "WHERE storage_key = %s AND status = 'ready'",
                (key,),
            ).fetchone()
            if existing:
                return _artifact(existing)
            byte_size, expires_at, _ = self._pending_grant(connection, key, content_hash, player_id=player_id)
        payload = self._fetch_verified(key, byte_size, content_hash, expires_at)
        validate_artifact_payload(
            payload, manifest, artifact_type=artifact_type, dependency=dependency,
            config_hash=config_hash, result_count=moves,
        )
        with self._database.transaction() as connection:
            row = connection.execute(
                "INSERT INTO derived_artifacts (player_id, account_id, artifact_type, "
                "dependency_hash, schema_version, storage_bucket, storage_key, status, metadata, "
                "analysis_config_hash, content_hash, byte_size, compute_source) "
                "VALUES (%s, NULL, %s, %s, %s, %s, %s, 'ready', %s, %s, %s, %s, "
                "'community_computed') "
                "ON CONFLICT (player_id, account_id, artifact_type, dependency_hash, schema_version) "
                "DO UPDATE SET storage_key = excluded.storage_key, "
                "content_hash = excluded.content_hash, byte_size = excluded.byte_size, "
                "status = 'ready', created_at = now() "
                f"RETURNING {_ARTIFACT_COLUMNS}",
                (
                    player_id, artifact_type, dependency, str(ARTIFACT_SCHEMA_VERSION),
                    self._storage.bucket, key, Jsonb({"manifest_hash": manifest.hash}),
                    config_hash, content_hash, byte_size,
                ),
            ).fetchone()
            if artifact_type == "puzzles":
                PracticeRepository.import_puzzles(connection, player_id, dependency, payload["puzzles"])
                PracticeRepository.activate_results(connection, player_id, None, dependency)
            connection.execute(
                "UPDATE analysis_upload_grants SET consumed_at = now() WHERE storage_key = %s",
                (key,),
            )
        return _artifact(row)

    def ready_artifacts(self, player_id: str) -> list[Artifact]:
        """Latest ready, non-quarantined artifact of each type for a player."""
        with self._database.transaction() as connection:
            rows = connection.execute(
                f"SELECT DISTINCT ON (a.artifact_type) "
                f"{', '.join('a.' + c for c in _ARTIFACT_COLUMNS.split(', '))} "
                "FROM derived_artifacts a "
                "LEFT JOIN analysis_configs c ON c.config_hash = a.analysis_config_hash "
                "WHERE a.player_id = %s AND a.account_id IS NULL AND a.status = 'ready' "
                "AND a.quarantined_at IS NULL AND c.quarantined_at IS NULL "
                "ORDER BY a.artifact_type, a.created_at DESC",
                (player_id,),
            ).fetchall()
        return [_artifact(row) for row in rows]

    # Maintenance -------------------------------------------------------------------

    def cleanup_orphans(self, *, older_than: timedelta = timedelta(hours=1)) -> int:
        """Delete expired, never-finalized uploads. Returns the number removed."""
        with self._database.transaction() as connection:
            rows = connection.execute(
                "DELETE FROM analysis_upload_grants g WHERE g.consumed_at IS NULL "
                "AND g.expires_at < now() - make_interval(secs => %s) "
                "AND NOT EXISTS (SELECT 1 FROM analysis_checkpoints c "
                "WHERE c.storage_key = g.storage_key) "
                "AND NOT EXISTS (SELECT 1 FROM derived_artifacts a "
                "WHERE a.storage_key = g.storage_key) RETURNING g.storage_key",
                (older_than.total_seconds(),),
            ).fetchall()
            keys = [row[0] for row in rows]
            self._storage.delete(keys)
        return len(keys)

