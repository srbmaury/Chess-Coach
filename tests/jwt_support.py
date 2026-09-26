"""Supabase-style ES256 session tokens for tests, verified via an in-memory JWKS."""

from __future__ import annotations

import json
import time

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

SUPABASE_URL = "https://project.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"
KID = "test-signing-key"

_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def _public_jwk(private_key, kid: str) -> dict:
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key()))
    return {**jwk, "kid": kid, "alg": "ES256", "use": "sig"}


class StaticJwks:
    """Stands in for ``jwt.PyJWKClient`` with the project's published keys."""

    def __init__(self, *keys: dict):
        self.keys = {key["kid"]: jwt.PyJWK(key) for key in keys or (_public_jwk(_PRIVATE_KEY, KID),)}

    def get_signing_key_from_jwt(self, token: str) -> jwt.PyJWK:
        kid = jwt.get_unverified_header(token).get("kid")
        if kid not in self.keys:
            raise jwt.PyJWKClientError(f"Unable to find a signing key that matches: {kid}")
        return self.keys[kid]


def token(
    subject: str = "11111111-1111-1111-1111-111111111111",
    *,
    email: str | None = "player@example.com",
    kid: str = KID,
    foreign_key: bool = False,
    **overrides,
) -> str:
    now = int(time.time())
    claims = {
        "sub": subject,
        "email": email,
        "aud": "authenticated",
        "iss": ISSUER,
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        **overrides,
    }
    claims = {key: value for key, value in claims.items() if value is not None}
    signer = _OTHER_KEY if foreign_key else _PRIVATE_KEY
    return jwt.encode(claims, signer, algorithm="ES256", headers={"kid": kid})


def verifier(settings=None):
    from chess_ml_coach.config import Settings
    from chess_ml_coach.hosted.identity import SupabaseJwtVerifier

    return SupabaseJwtVerifier.from_settings(
        settings or Settings(supabase_url=SUPABASE_URL), keys=StaticJwks()
    )
