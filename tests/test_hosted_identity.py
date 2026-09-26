import base64
import hashlib
import hmac
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from jwt_support import ISSUER, KID, SUPABASE_URL, StaticJwks, token, verifier

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.identity import (
    AuthConfigurationError,
    InvalidTokenError,
    SupabaseJwtVerifier,
)

SUBJECT = "11111111-1111-1111-1111-111111111111"


def test_verifier_requires_the_project_url():
    with pytest.raises(AuthConfigurationError, match="SUPABASE_URL"):
        SupabaseJwtVerifier.from_settings(Settings())


def test_default_key_source_is_the_projects_jwks_endpoint():
    source = SupabaseJwtVerifier.from_settings(Settings(supabase_url=SUPABASE_URL))._keys
    assert isinstance(source, jwt.PyJWKClient)
    assert source.uri == f"{ISSUER}/.well-known/jwks.json"


def test_valid_es256_token_resolves_subject_and_email():
    identity = verifier().verify(token(SUBJECT))
    assert identity.subject == SUBJECT
    assert identity.email == "player@example.com"


def test_token_without_email_is_allowed():
    assert verifier().verify(token(SUBJECT, email=None)).email is None


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(lambda: token(exp=int(time.time()) - 10), id="expired"),
        pytest.param(lambda: token(foreign_key=True), id="signed-by-another-key"),
        pytest.param(lambda: token(kid="unknown-kid"), id="unknown-kid"),
        pytest.param(lambda: token(aud="some-other-app"), id="wrong-audience"),
        pytest.param(lambda: token(iss="https://other.supabase.co/auth/v1"), id="other-project"),
        pytest.param(lambda: token(iss=None), id="missing-issuer"),
        pytest.param(lambda: token(exp=None), id="missing-expiry"),
        pytest.param(lambda: "not-a-jwt", id="malformed"),
    ],
)
def test_untrustworthy_tokens_are_rejected(bad):
    with pytest.raises(InvalidTokenError):
        verifier().verify(bad())


def test_missing_subject_is_rejected():
    now = int(time.time())
    claims = {"aud": "authenticated", "iss": ISSUER, "exp": now + 60}
    unsigned_subject = jwt.encode(claims, _signing_key(), algorithm="ES256", headers={"kid": KID})
    with pytest.raises(InvalidTokenError):
        verifier().verify(unsigned_subject)


def test_shared_secret_hs256_tokens_are_rejected():
    hs256 = jwt.encode(
        {"sub": SUBJECT, "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 60},
        "a-shared-secret-that-is-at-least-32-bytes",
        algorithm="HS256",
        headers={"kid": KID},
    )
    with pytest.raises(InvalidTokenError):
        verifier().verify(hs256)


def _b64(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def test_public_key_cannot_be_used_as_an_hmac_secret():
    # Algorithm confusion: an attacker signs HS256 using the *published* public key.
    public_key = next(iter(StaticJwks().keys.values())).key
    public_pem = public_key.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    header = {"alg": "HS256", "typ": "JWT", "kid": KID}
    body = {"sub": SUBJECT, "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 60}
    signing_input = _b64(json.dumps(header).encode()) + b"." + _b64(json.dumps(body).encode())
    signature = _b64(hmac.new(public_pem, signing_input, hashlib.sha256).digest())
    with pytest.raises(InvalidTokenError):
        verifier().verify((signing_input + b"." + signature).decode())


def test_unsigned_none_tokens_are_rejected():
    unsigned = jwt.encode(
        {"sub": SUBJECT, "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 60},
        None,
        algorithm="none",
    )
    with pytest.raises(InvalidTokenError):
        verifier().verify(unsigned)


def _signing_key():
    import jwt_support

    return jwt_support._PRIVATE_KEY
