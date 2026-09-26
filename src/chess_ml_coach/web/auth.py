from __future__ import annotations

from fastapi import HTTPException, Request

from ..hosted.accounts import Account
from ..hosted.identity import InvalidTokenError


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization")
    if not header or not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="A bearer session token is required")
    return header.split(" ", 1)[1].strip()


def require_account(request: Request) -> Account:
    verifier = request.app.state.jwt_verifier
    repository = request.app.state.account_repository
    if verifier is None or repository is None:
        raise HTTPException(status_code=503, detail="Hosted authentication is not configured")
    token = _bearer_token(request)
    try:
        identity = verifier.verify(token)
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session token") from exc
    return repository.upsert(account_id=identity.subject, email=identity.email or "")
