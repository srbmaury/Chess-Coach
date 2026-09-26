from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import jwt

from ..config import Settings

# Supabase signs sessions with asymmetric keys published at the project's JWKS
# endpoint. Only these algorithms are accepted; "none" and shared-secret HS256
# tokens are always rejected.
ALLOWED_ALGORITHMS = ("ES256", "RS256")


class AuthConfigurationError(RuntimeError):
    pass


class InvalidTokenError(RuntimeError):
    pass


@dataclass(frozen=True)
class VerifiedIdentity:
    subject: str
    email: str | None


class SigningKeySource(Protocol):
    """Resolves a token's signing key by its ``kid`` (e.g. ``jwt.PyJWKClient``)."""

    def get_signing_key_from_jwt(self, token: str) -> jwt.PyJWK: ...


def auth_issuer(supabase_url: str) -> str:
    return f"{supabase_url.rstrip('/')}/auth/v1"


class SupabaseJwtVerifier:
    def __init__(self, *, keys: SigningKeySource, audience: str, issuer: str):
        self._keys = keys
        self._audience = audience
        self._issuer = issuer

    @classmethod
    def from_settings(
        cls, settings: Settings, *, keys: SigningKeySource | None = None
    ) -> SupabaseJwtVerifier:
        if not settings.supabase_url:
            raise AuthConfigurationError("SUPABASE_URL is required for authentication")
        issuer = auth_issuer(settings.supabase_url)
        # Keys are cached and refetched when an unknown kid appears (key rotation).
        source = keys or jwt.PyJWKClient(
            f"{issuer}/.well-known/jwks.json", cache_keys=True, lifespan=600, timeout=10
        )
        return cls(keys=source, audience=settings.supabase_jwt_audience, issuer=issuer)

    def verify(self, token: str) -> VerifiedIdentity:
        try:
            algorithm = jwt.get_unverified_header(token).get("alg")
            if algorithm not in ALLOWED_ALGORITHMS:
                raise InvalidTokenError("Unsupported session token algorithm")
            key = self._keys.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=[algorithm],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "sub", "aud", "iss"]},
            )
        except jwt.PyJWTError as exc:
            raise InvalidTokenError("Invalid or expired session token") from exc
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise InvalidTokenError("Token is missing a subject claim")
        email = claims.get("email")
        return VerifiedIdentity(subject=subject, email=email if isinstance(email, str) else None)
