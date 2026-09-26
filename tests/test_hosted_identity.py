import time

import jwt
import pytest

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.identity import (
    AuthConfigurationError,
    InvalidTokenError,
    SupabaseJwtVerifier,
)

SECRET = "test-secret-at-least-32-bytes-long-for-hs256"
SUBJECT = "11111111-1111-1111-1111-111111111111"


def _token(**overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": SUBJECT,
        "email": "player@example.com",
        "aud": "authenticated",
        "exp": now + 3600,
        "iat": now,
        **overrides,
    }
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_verifier_requires_a_configured_secret():
    with pytest.raises(AuthConfigurationError):
        SupabaseJwtVerifier.from_settings(Settings())


def test_valid_token_resolves_subject_and_email():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))

    identity = verifier.verify(_token())

    assert identity.subject == SUBJECT
    assert identity.email == "player@example.com"


def test_expired_token_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify(_token(exp=int(time.time()) - 10))


def test_token_signed_with_a_different_secret_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    forged = jwt.encode(
        {"sub": SUBJECT, "aud": "authenticated", "exp": int(time.time()) + 3600},
        "a-different-secret-also-at-least-32-bytes",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        verifier.verify(forged)


def test_token_missing_a_subject_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    claims = {"aud": "authenticated", "exp": int(time.time()) + 3600}
    token = jwt.encode(claims, SECRET, algorithm="HS256")
    with pytest.raises(InvalidTokenError):
        verifier.verify(token)


def test_token_with_the_wrong_audience_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify(_token(aud="some-other-app"))


def test_malformed_token_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify("not-a-jwt")
