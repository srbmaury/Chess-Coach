"""Helpers shared by live hosted-database tests."""

from __future__ import annotations

import uuid
from datetime import datetime

from chess_ml_coach.chesscom import ChessComNotFoundError, ChessComPlayer
from chess_ml_coach.hosted.storage import (
    ObjectNotFoundError,
    ObjectTooLargeError,
    SignedUpload,
    StorageError,
    StoredObject,
)


def new_account(pg, email: str | None = None) -> str:
    account_id = str(uuid.uuid4())
    with pg.transaction() as connection:
        connection.execute(
            "INSERT INTO accounts (id, email) VALUES (%s, %s)",
            (account_id, email or f"{account_id}@example.test"),
        )
    return account_id


def subscribe(pg, account_id: str, status: str = "active") -> None:
    with pg.transaction() as connection:
        connection.execute(
            "INSERT INTO subscriptions (account_id, stripe_subscription_id, stripe_price_id, status) "
            "VALUES (%s, %s, 'price', %s)",
            (account_id, f"sub_{uuid.uuid4().hex}", status),
        )


class FakePlayerLookup:
    def __init__(self, players: dict[str, int] | None = None):
        self.players = players or {}
        self.calls: list[str] = []

    def __call__(self, username: str) -> ChessComPlayer:
        self.calls.append(username)
        if username not in self.players:
            if self.players:
                raise ChessComNotFoundError("missing")
            return ChessComPlayer(player_id=abs(hash(username)) % 10_000_000, username=username)
        return ChessComPlayer(player_id=self.players[username], username=username.title())


def entitled_player(pg, account_id: str, username: str = "magnuscarlsen") -> str:
    from chess_ml_coach.hosted.profiles import ProfileRepository

    return ProfileRepository(pg, player_lookup=FakePlayerLookup()).claim(account_id, username).player.id


def hosted_config():
    from chess_ml_coach.hosted.analysis_config import HostedAnalysisConfig

    return HostedAnalysisConfig(
        depth=12, inaccuracy_cpl=50, mistake_cpl=100, blunder_cpl=200, min_group_size=10
    )


def create_job(pg, account_id: str, player_id: str, *, manifest_hash: str = "m" * 64,
               total_units: int = 4, can_compute: bool = True):
    from chess_ml_coach.hosted.jobs import JobRepository

    repository = JobRepository(pg)
    config = hosted_config()
    return repository.create_or_join(
        account_id=account_id,
        player_id=player_id,
        config_id=repository.ensure_config(config),
        engine_build_hash=config.engine_build_hash,
        manifest_hash=manifest_hash,
        manifest_storage_key=f"players/{player_id}/manifests/{manifest_hash}.json.gz",
        total_units=total_units,
        can_compute=can_compute,
    )


def expire_lease(pg, job_id: str) -> None:
    with pg.transaction() as connection:
        connection.execute(
            "UPDATE analysis_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (job_id,),
        )


DEVICE_A = "device-aaaaaaaaaaaaaaaa"
DEVICE_B = "device-bbbbbbbbbbbbbbbb"


class InMemoryStorage:
    """Test double with the same contract: immutable keys, signed URLs, bounded reads."""

    def __init__(self, bucket: str = "analysis-artifacts"):
        self.bucket = bucket
        self.objects: dict[str, StoredObject] = {}
        self.signed_uploads: list[str] = []

    def create_upload(self, key: str) -> SignedUpload:
        self.signed_uploads.append(key)
        return SignedUpload(storage_key=key, url=f"memory://upload/{key}?token=signed")

    def signed_download_url(self, key: str, *, expires_in: int = 300) -> str:
        if key not in self.objects:
            raise ObjectNotFoundError("Stored object is missing")
        return f"memory://download/{key}?expires={expires_in}"

    def upload_signed(self, key: str, body: bytes, *, at: datetime | None = None) -> None:
        if key not in self.signed_uploads:
            raise StorageError("Upload was not signed")
        if key in self.objects:
            raise StorageError("Duplicate")
        self.objects[key] = StoredObject(body=body, last_modified=at)

    def put(self, key: str, body: bytes) -> None:
        self.objects.setdefault(key, StoredObject(body=body, last_modified=None))

    def get(self, key: str, *, max_bytes: int) -> StoredObject:
        stored = self.objects.get(key)
        if stored is None:
            raise ObjectNotFoundError("Stored object is missing")
        if len(stored.body) > max_bytes:
            raise ObjectTooLargeError("Stored object exceeds the size limit")
        return stored

    def delete(self, keys: list[str]) -> None:
        for key in keys:
            self.objects.pop(key, None)


# API harness ---------------------------------------------------------------------------

def jwt_for(account_id: str, email: str | None = None) -> str:
    from jwt_support import token

    return token(account_id, email=email or f"{account_id}@example.test")


def pgn_for(game_number: int, white: str, black: str, moves: str, date: str) -> str:
    site = f"https://www.chess.com/game/live/{game_number}"
    return (
        f'[Event "Live Chess"]\n[Site "{site}"]\n[Date "{date}"]\n[White "{white}"]\n'
        f'[Black "{black}"]\n[Result "*"]\n[TimeControl "180+2"]\n[ECO "C20"]\n'
        f'[Link "{site}"]\n\n{moves} *'
    )


DEFAULT_GAMES = [
    pgn_for(1, "MagnusCarlsen", "opp1", "1. e4 e5 2. Nf3 Nc6 3. Bb5", "2026.09.01"),
    pgn_for(2, "opp2", "MagnusCarlsen", "1. d4 d5 2. c4 e6", "2026.09.02"),
    pgn_for(3, "MagnusCarlsen", "opp3", "1. c4 e5 2. Nc3", "2026.09.03"),
]


def chesscom_client(games: list[str] | None = None):
    import httpx

    from chess_ml_coach.chesscom import ChessComClient

    served = DEFAULT_GAMES if games is None else games

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/games/archives"):
            return httpx.Response(200, json={"archives": ["https://api.chess.com/pub/m/1"]})
        if path.startswith("/pub/m/"):
            return httpx.Response(200, json={"games": [{"pgn": text} for text in served]})
        if path.startswith("/pub/player/"):
            username = path.rsplit("/", 1)[-1]
            if username == "ghostplayer":
                return httpx.Response(404)
            return httpx.Response(200, json={"player_id": abs(hash(username)) % 10**7,
                                             "username": username})
        return httpx.Response(404)

    return ChessComClient(httpx.Client(transport=httpx.MockTransport(handler)))


def hosted_app(pg, *, storage=None, enabled: bool = True, games: list[str] | None = None,
               rate_limiter=None):
    from jwt_support import verifier

    from chess_ml_coach.config import Settings
    from chess_ml_coach.hosted.accounts import PostgresAccountRepository
    from chess_ml_coach.web.app import create_app
    from chess_ml_coach.web.hosted_analysis_routes import build_hosted_analysis

    settings = Settings(
        persistence_mode="hosted",
        database_url="postgresql://unused.invalid/db",
        supabase_url="https://project.supabase.co",
        supabase_publishable_key="sb_publishable_test",
        supabase_secret_key="sb_secret_server_only_value",
        hosted_browser_analysis_enabled=enabled,
    )
    storage = storage or InMemoryStorage()
    services = build_hosted_analysis(
        settings, pg, storage=storage, chesscom=chesscom_client(games), rate_limiter=rate_limiter
    )
    app = create_app(
        settings,
        jwt_verifier=verifier(settings),
        account_repository=PostgresAccountRepository(pg),
        hosted_analysis=services,
    )
    return app, services, storage


class BrowserClient:
    """Drives the hosted API the way the browser coordinator does."""

    def __init__(self, app, storage, account_id: str, device_id: str):
        from fastapi.testclient import TestClient

        self.client = TestClient(app)
        self.storage = storage
        self.account_id = account_id
        self.device_id = device_id
        self.headers = {"Authorization": f"Bearer {jwt_for(account_id)}"}
        self.token: str | None = None

    def get(self, path: str, **kwargs):
        return self.client.get(path, headers=self.headers, **kwargs)

    def post(self, path: str, body: dict | None = None, **kwargs):
        return self.client.post(path, json=body or {}, headers=self.headers, **kwargs)

    def claim_profile(self, username: str = "magnuscarlsen") -> str:
        response = self.post("/api/hosted/profiles", {"username": username})
        assert response.status_code == 201, response.text
        return next(p["player_id"] for p in response.json()["profiles"]
                    if p["username"] == username.lower())

    def join(self, player_id: str, can_compute: bool = True) -> dict:
        response = self.post("/api/hosted/jobs", {"player_id": player_id, "can_compute": can_compute})
        assert response.status_code == 200, response.text
        return response.json()

    def claim(self, job_id: str):
        response = self.post(f"/api/hosted/jobs/{job_id}/lease/claim", {"device_id": self.device_id})
        if response.status_code == 200:
            self.token = response.json()["lease_token"]
        return response

    def lease_body(self, **extra) -> dict:
        return {"device_id": self.device_id, "lease_token": self.token, **extra}

    def manifest_games(self, job_id: str) -> list[dict]:
        import gzip
        import json

        response = self.get(f"/api/hosted/jobs/{job_id}/manifest")
        assert response.status_code == 200, response.text
        key = response.json()["download_url"].split("memory://download/", 1)[1].split("?")[0]
        return json.loads(gzip.decompress(self.storage.objects[key].body))["games"]

    def upload(self, job_id: str, kind: str, body: bytes, **fields):
        from hashlib import sha256

        request = self.lease_body(kind=kind, byte_size=len(body),
                                  content_hash=sha256(body).hexdigest(), **fields)
        response = self.post(f"/api/hosted/jobs/{job_id}/uploads", request)
        if response.status_code == 200 and response.json()["upload_url"]:
            self.storage.upload_signed(response.json()["storage_key"], body)
        return response

    def checkpoint(self, job_id: str, sequence: int, payload: dict):
        from hashlib import sha256

        body = gzip_json(payload)
        upload = self.upload(job_id, "checkpoint", body, sequence=sequence)
        assert upload.status_code == 200, upload.text
        return self.post(f"/api/hosted/jobs/{job_id}/checkpoints/finalize",
                         self.lease_body(sequence=sequence, content_hash=sha256(body).hexdigest()))

    def artifact(self, job_id: str, artifact_type: str, payload: dict):
        from hashlib import sha256

        body = gzip_json(payload)
        upload = self.upload(job_id, "artifact", body, artifact_type=artifact_type)
        assert upload.status_code == 200, upload.text
        return self.post(f"/api/hosted/jobs/{job_id}/artifacts/finalize",
                         self.lease_body(artifact_type=artifact_type,
                                         content_hash=sha256(body).hexdigest()))


def gzip_json(document: object) -> bytes:
    import gzip
    import json

    return gzip.compress(json.dumps(document, separators=(",", ":")).encode(), mtime=0)


def analysis_rows(game: dict) -> list[dict]:
    """Structurally valid rows where the player always found the engine move."""
    first = 1 if game["user_color"] == "white" else 2
    return [
        {"ply": ply, "best_move_uci": game["moves"][ply - 1], "eval_before_cp": 20,
         "eval_after_cp": 20, "mate_before": None, "mate_after": None,
         "expected_score_before": 0.52, "expected_score_after": 0.52, "cpl": 0,
         "quality": "best", "quality_reason": "engine top move"}
        for ply in range(first, len(game["moves"]) + 1, 2)
    ]


def checkpoint_payload(job: dict, games: list[dict], sequence: int, first: int, last: int,
                       engine_hash: str) -> dict:
    return {
        "schema_version": 1, "job_id": job["id"], "sequence": sequence,
        "analysis_config_hash": job["analysis_config_hash"], "engine_build_hash": engine_hash,
        "first_unit": first, "last_unit": last,
        "games": [{"game_id": games[i]["game_id"], "rows": analysis_rows(games[i])}
                  for i in range(first, last + 1)],
    }


def artifact_payload(artifact_type: str, dependency: str, config_hash: str, **fields) -> dict:
    base = {"schema_version": 1, "artifact_type": artifact_type, "dependency_hash": dependency,
            "analysis_config_hash": config_hash}
    defaults = {
        "puzzles": {"puzzles": []},
        "model_summary": {"status": "insufficient_data", "reason": "too few games"},
        "report": {"markdown": "# Chess ML Coach Report\n", "overall": {"samples": 0}},
    }[artifact_type]
    return {**base, **defaults, **fields}
