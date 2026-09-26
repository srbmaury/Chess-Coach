import json

import httpx
import pytest

from chess_ml_coach.hosted.checkpoints import artifact_storage_key, checkpoint_storage_key
from chess_ml_coach.hosted.storage import (
    ObjectNotFoundError,
    ObjectTooLargeError,
    StorageError,
    SupabaseStorage,
)

SECRET = "sb_secret_do_not_leak_this_value"


def _storage(handler) -> tuple[SupabaseStorage, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    storage = SupabaseStorage(
        base_url="https://project.supabase.co",
        secret_key=SECRET,
        bucket="analysis-artifacts",
        http=httpx.Client(transport=httpx.MockTransport(record)),
    )
    return storage, seen


def test_object_keys_bind_job_config_sequence_and_hash():
    key = checkpoint_storage_key("job-1", "c" * 64, 7, "a" * 64)
    assert key == f"jobs/job-1/checkpoints/{'c' * 16}/00000007-{'a' * 64}.json.gz"
    artifact = artifact_storage_key("player-1", "report", "d" * 64, "a" * 64)
    assert artifact == f"players/player-1/artifacts/report/{'d' * 64}-{'a' * 64}.json.gz"


def test_signed_upload_is_object_scoped_and_never_upserts():
    storage, seen = _storage(lambda request: httpx.Response(
        200, json={"url": "/object/upload/sign/analysis-artifacts/jobs/j/x.json.gz?token=signed"}
    ))

    upload = storage.create_upload("jobs/j/x.json.gz")

    assert upload.url == ("https://project.supabase.co/storage/v1/object/upload/sign/"
                          "analysis-artifacts/jobs/j/x.json.gz?token=signed")
    assert upload.content_type == "application/gzip"
    request = seen[0]
    assert request.method == "POST"
    assert request.url.path == "/storage/v1/object/upload/sign/analysis-artifacts/jobs/j/x.json.gz"
    assert request.headers["x-upsert"] == "false"
    assert request.headers["apikey"] == SECRET


def test_signed_download_expiry_is_explicit():
    storage, seen = _storage(lambda request: httpx.Response(
        200, json={"signedURL": "/object/sign/analysis-artifacts/k?token=t"}
    ))

    url = storage.signed_download_url("k", expires_in=300)

    assert url.endswith("/storage/v1/object/sign/analysis-artifacts/k?token=t")
    assert json.loads(seen[0].content) == {"expiresIn": 300}


def test_get_is_bounded_and_reports_last_modified():
    body = b"x" * 100
    storage, _ = _storage(lambda request: httpx.Response(
        200, content=body, headers={"Last-Modified": "Sat, 26 Sep 2026 12:00:00 GMT"}
    ))

    stored = storage.get("k", max_bytes=100)
    assert stored.body == body
    assert stored.last_modified.year == 2026
    with pytest.raises(ObjectTooLargeError):
        storage.get("k", max_bytes=99)


def test_missing_objects_and_duplicate_puts():
    storage, _ = _storage(lambda request: httpx.Response(
        404 if request.method == "GET" else 400,
        json={"statusCode": "409", "error": "Duplicate", "message": "The resource already exists"},
    ))

    with pytest.raises(ObjectNotFoundError):
        storage.get("k", max_bytes=10)
    storage.put("players/p/manifests/h.json.gz", b"body")


def test_errors_never_contain_the_secret_or_signed_token():
    storage, _ = _storage(lambda request: httpx.Response(500, text=f"boom {SECRET} token=signed"))

    for call in (
        lambda: storage.create_upload("k"),
        lambda: storage.signed_download_url("k"),
        lambda: storage.put("k", b"x"),
        lambda: storage.get("k", max_bytes=10),
    ):
        with pytest.raises(StorageError) as caught:
            call()
        assert SECRET not in str(caught.value)
        assert "token=" not in str(caught.value)


def test_transport_failures_are_sanitized():
    def fail(request):
        raise httpx.ConnectError(f"cannot reach {request.url} with {SECRET}")

    storage, _ = _storage(fail)
    with pytest.raises(StorageError) as caught:
        storage.create_upload("k")
    assert SECRET not in str(caught.value)
    assert caught.value.__cause__ is None


def test_delete_batches_keys():
    storage, seen = _storage(lambda request: httpx.Response(200, json=[]))
    storage.delete([])
    storage.delete(["a", "b"])

    assert len(seen) == 1
    assert json.loads(seen[0].content) == {"prefixes": ["a", "b"]}
