"""Per-account and per-client-IP rate limits for hosted coordination endpoints."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class RateLimitedError(RuntimeError):
    code = "rate_limited"


@dataclass(frozen=True)
class Limit:
    capacity: int
    per_seconds: float


# Renewals arrive every 20 seconds; the rest are bursts around user actions.
DEFAULT_LIMITS: dict[str, Limit] = {
    "profile": Limit(capacity=20, per_seconds=60),
    "join": Limit(capacity=30, per_seconds=60),
    "claim": Limit(capacity=30, per_seconds=60),
    "renew": Limit(capacity=12, per_seconds=60),
    "upload": Limit(capacity=120, per_seconds=60),
    "finalize": Limit(capacity=120, per_seconds=60),
}


class RateLimiter(Protocol):
    def check(self, action: str, *, account_id: str, client_ip: str | None) -> None: ...


class InMemoryRateLimiter:
    """Token buckets in process memory.

    Sufficient for a single Render instance; a multi-instance deployment should supply
    a shared implementation of :class:`RateLimiter`.
    """

    def __init__(
        self,
        limits: dict[str, Limit] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 50_000,
    ):
        self._limits = limits or DEFAULT_LIMITS
        self._clock = clock
        self._max_keys = max_keys
        self._buckets: dict[tuple[str, str], tuple[float, float]] = {}
        self._lock = threading.Lock()

    def _take(self, key: tuple[str, str], limit: Limit, now: float) -> bool:
        tokens, updated = self._buckets.get(key, (float(limit.capacity), now))
        tokens = min(limit.capacity, tokens + (now - updated) * limit.capacity / limit.per_seconds)
        if tokens < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1, now)
        return True

    def check(self, action: str, *, account_id: str, client_ip: str | None) -> None:
        limit = self._limits.get(action)
        if limit is None:
            return
        now = self._clock()
        with self._lock:
            if len(self._buckets) > self._max_keys:
                self._buckets.clear()
            allowed = self._take((action, f"account:{account_id}"), limit, now)
            if client_ip:
                # An IP may host several accounts; allow it a larger shared budget.
                ip_limit = Limit(limit.capacity * 5, limit.per_seconds)
                allowed = self._take((action, f"ip:{client_ip}"), ip_limit, now) and allowed
        if not allowed:
            raise RateLimitedError("Too many requests; slow down and retry shortly")
