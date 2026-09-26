from __future__ import annotations

from dataclasses import dataclass

import jwt

from ..config import Settings


class AuthConfigurationError(RuntimeError):
    pass


class InvalidTokenError(RuntimeError):
    pass


@dataclass(frozen=True)
class VerifiedIdentity:
    subject: str
    email: str | None


class SupabaseJwtVerifier:
    def __init__(self, *, secret: str, audience: str):
        self._secret = secret
        self._audience = audience

    @classmethod
    def from_settings(cls, settings: Settings) -> SupabaseJwtVerifier:
        if not settings.supabase_jwt_secret:
            raise AuthConfigurationError("SUPABASE_JWT_SECRET is required for authentication")
        return cls(secret=settings.supabase_jwt_secret, audience=settings.supabase_jwt_audience)

    def verify(self, token: str) -> VerifiedIdentity:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                audience=self._audience,
            )
        except jwt.PyJWTError as exc:
            raise InvalidTokenError("Invalid or expired session token") from exc
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise InvalidTokenError("Token is missing a subject claim")
        email = claims.get("email")
        return VerifiedIdentity(subject=subject, email=email if isinstance(email, str) else None)
