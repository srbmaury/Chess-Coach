"""The renewable worker lease: at most one browser computes a shared job at a time.

Lease tokens are 32 random bytes returned once to the claimant; only their SHA-256
digest is stored. Every comparison of time uses PostgreSQL's ``now()``; nothing the
client says about time or ownership is trusted.
"""

from __future__ import annotations

import hmac
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256

from psycopg.types.json import Jsonb

from .database import Database
from .jobs import TERMINAL, JobNotFoundError, clear_lease, settle_unleased_status

LEASE_SECONDS = 60
RENEW_INTERVAL_SECONDS = 20
_DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class LeaseError(RuntimeError):
    code = "lease_error"


class LeaseUnavailableError(LeaseError):
    """Another browser holds a valid lease, or the job is finished."""

    code = "lease_unavailable"


class ObserverOnlyError(LeaseError):
    code = "observer_only"


class LeaseLostError(LeaseError):
    code = "lease_lost"


class InvalidDeviceError(LeaseError):
    code = "invalid_device"


@dataclass(frozen=True)
class LeaseGrant:
    job_id: str
    token: str
    expires_at: datetime
    lease_seconds: int
    renew_interval_seconds: int
    completed_work: int
    total_work: int
    checkpoint_sequence: int


@dataclass(frozen=True)
class LeaseState:
    """A verified, row-locked lease inside the caller's transaction."""

    job_id: str
    player_id: str
    account_id: str
    device_id: str
    token_digest: str
    completed_work: int
    total_work: int
    checkpoint_sequence: int
    analysis_config_hash: str
    engine_build_hash: str
    manifest_hash: str
    manifest_storage_key: str


def token_digest(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def validate_device_id(device_id: str) -> str:
    if not isinstance(device_id, str) or not _DEVICE_ID.fullmatch(device_id):
        raise InvalidDeviceError("Invalid device identifier")
    return device_id


def _audit(connection, account_id: str, action: str, job_id: str, details: dict) -> None:
    connection.execute(
        "INSERT INTO audit_events (actor_account_id, actor_type, action, target_type, target_id, "
        "details) VALUES (%s, 'account', %s, 'analysis_job', %s, %s)",
        (account_id, action, job_id, Jsonb(details)),
    )


def verify_lease(connection, job_id: str, account_id: str, device_id: str, token: str) -> LeaseState:
    """Lock the job row and prove the caller still owns a valid lease."""
    validate_device_id(device_id)
    row = connection.execute(
        "SELECT j.status, j.lease_token_digest, j.lease_account_id::text, j.lease_device_id, "
        "j.lease_expires_at > now(), j.completed_work, j.total_work, j.checkpoint_sequence, "
        "j.player_id::text, j.analysis_config_hash, j.engine_build_hash, j.input_game_set_hash, "
        "j.manifest_storage_key, EXISTS (SELECT 1 FROM job_subscribers s WHERE s.job_id = j.id "
        "AND s.account_id = %s AND s.state = 'active' AND s.can_compute) "
        "FROM analysis_jobs j WHERE j.id = %s FOR UPDATE",
        (account_id, job_id),
    ).fetchone()
    if row is None:
        raise JobNotFoundError("Analysis job not found")
    (status, digest, lease_account, lease_device, valid, completed, total, sequence,
     player_id, config_hash, engine_hash, manifest_hash, manifest_key, subscribed) = row
    presented = token_digest(token) if isinstance(token, str) and token else ""
    if not (
        status == "running"
        and digest is not None
        and valid
        and subscribed
        and lease_account == account_id
        and lease_device == device_id
        and hmac.compare_digest(digest, presented)
    ):
        raise LeaseLostError("This browser no longer holds the analysis lease")
    return LeaseState(
        job_id=job_id,
        player_id=player_id,
        account_id=account_id,
        device_id=device_id,
        token_digest=digest,
        completed_work=completed,
        total_work=total,
        checkpoint_sequence=sequence,
        analysis_config_hash=config_hash,
        engine_build_hash=engine_hash,
        manifest_hash=manifest_hash,
        manifest_storage_key=manifest_key,
    )


class LeaseService:
    def __init__(
        self,
        database: Database,
        *,
        lease_seconds: int = LEASE_SECONDS,
        renew_interval_seconds: int = RENEW_INTERVAL_SECONDS,
        token_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
    ):
        if not 0 < renew_interval_seconds * 2 <= lease_seconds:
            raise ValueError("Leases must be renewed before half their duration")
        self._database = database
        self._lease_seconds = lease_seconds
        self._renew_interval = renew_interval_seconds
        self._token_factory = token_factory

    def _grant(self, connection, job_id: str, token: str) -> LeaseGrant:
        row = connection.execute(
            "SELECT lease_expires_at, completed_work, total_work, checkpoint_sequence "
            "FROM analysis_jobs WHERE id = %s",
            (job_id,),
        ).fetchone()
        return LeaseGrant(
            job_id=job_id,
            token=token,
            expires_at=row[0],
            lease_seconds=self._lease_seconds,
            renew_interval_seconds=self._renew_interval,
            completed_work=row[1],
            total_work=row[2],
            checkpoint_sequence=row[3],
        )

    def claim(self, job_id: str, account_id: str, device_id: str) -> LeaseGrant:
        validate_device_id(device_id)
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT status, lease_token_digest IS NOT NULL, lease_expires_at > now(), "
                "lease_account_id::text, lease_device_id FROM analysis_jobs WHERE id = %s "
                "FOR UPDATE",
                (job_id,),
            ).fetchone()
            if row is None:
                raise JobNotFoundError("Analysis job not found")
            status, leased, valid, lease_account, lease_device = row
            if status in TERMINAL:
                raise LeaseUnavailableError("This analysis has already finished")
            subscriber = connection.execute(
                "SELECT state, can_compute FROM job_subscribers WHERE job_id = %s AND account_id = %s",
                (job_id, account_id),
            ).fetchone()
            if subscriber is None or subscriber[0] != "active" or not subscriber[1]:
                raise ObserverOnlyError("This browser is observing only")
            same_owner = lease_account == account_id and lease_device == device_id
            if leased and valid and not same_owner:
                raise LeaseUnavailableError("Another browser is analyzing")
            token = self._token_factory()
            # Same-owner re-claims rotate the token (e.g. after a page refresh), which
            # also retires any other tab of this device still holding the old token.
            connection.execute(
                "UPDATE analysis_jobs SET lease_token_digest = %s, lease_account_id = %s, "
                "lease_device_id = %s, lease_expires_at = now() + make_interval(secs => %s), "
                "last_heartbeat_at = now(), status = 'running', "
                "started_at = COALESCE(started_at, now()), attempt_count = attempt_count + 1 "
                "WHERE id = %s",
                (token_digest(token), account_id, device_id, self._lease_seconds, job_id),
            )
            if leased and not same_owner:
                _audit(connection, account_id, "lease_takeover", job_id, {"expired": True})
            return self._grant(connection, job_id, token)

    def renew(self, job_id: str, account_id: str, device_id: str, token: str) -> LeaseGrant:
        with self._database.transaction() as connection:
            verify_lease(connection, job_id, account_id, device_id, token)
            connection.execute(
                "UPDATE analysis_jobs SET lease_expires_at = now() + make_interval(secs => %s), "
                "last_heartbeat_at = now() WHERE id = %s",
                (self._lease_seconds, job_id),
            )
            return self._grant(connection, job_id, token)

    def release(self, job_id: str, account_id: str, device_id: str, token: str) -> None:
        validate_device_id(device_id)
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT lease_token_digest, lease_account_id::text, lease_device_id "
                "FROM analysis_jobs WHERE id = %s FOR UPDATE",
                (job_id,),
            ).fetchone()
            if row is None:
                raise JobNotFoundError("Analysis job not found")
            digest, lease_account, lease_device = row
            presented = token_digest(token) if token else ""
            if (
                digest is None
                or lease_account != account_id
                or lease_device != device_id
                or not hmac.compare_digest(digest, presented)
            ):
                return  # Releasing a lease you do not hold is a no-op.
            clear_lease(connection, job_id)
            settle_unleased_status(connection, job_id)
