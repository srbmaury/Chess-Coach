"""Private Supabase Storage for manifests, checkpoints, and derived artifacts.

Browsers upload directly with short-lived, object-scoped signed upload URLs and
download with signed URLs; the Render process only streams bounded objects through
memory for validation. Nothing here touches the local filesystem, and no error or
log message contains the secret key or a signed token.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Protocol
from urllib.parse import quote

import httpx

CONTENT_TYPE = "application/gzip"


class StorageError(RuntimeError):
    code = "storage_unavailable"


class ObjectNotFoundError(StorageError):
    code = "object_missing"


class ObjectTooLargeError(StorageError):
    code = "object_too_large"


@dataclass(frozen=True)
class SignedUpload:
    storage_key: str
    url: str
    content_type: str = CONTENT_TYPE


@dataclass(frozen=True)
class StoredObject:
    body: bytes
    last_modified: datetime | None


class ArtifactStorage(Protocol):
    bucket: str

    def create_upload(self, key: str) -> SignedUpload: ...

    def signed_download_url(self, key: str, *, expires_in: int = 300) -> str: ...

    def put(self, key: str, body: bytes) -> None: ...

    def get(self, key: str, *, max_bytes: int) -> StoredObject: ...

    def delete(self, keys: list[str]) -> None: ...


def _object_path(key: str) -> str:
    return quote(key, safe="/")


class SupabaseStorage:
    def __init__(
        self,
        *,
        base_url: str,
        secret_key: str,
        bucket: str,
        http: httpx.Client | None = None,
    ):
        self._base = base_url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self._http = http or httpx.Client(timeout=30)
        self._headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {**self._headers, **kwargs.pop("headers", {})}
        try:
            return self._http.request(method, self._base + path, headers=headers, **kwargs)
        except httpx.HTTPError:
            raise StorageError("Storage is unavailable") from None

    def _absolute(self, relative: str) -> str:
        if not isinstance(relative, str) or not relative.startswith("/"):
            raise StorageError("Storage returned an invalid signed URL")
        return self._base + relative

    def create_upload(self, key: str) -> SignedUpload:
        response = self._request(
            "POST",
            f"/object/upload/sign/{self.bucket}/{_object_path(key)}",
            headers={"x-upsert": "false"},
        )
        if response.status_code >= 400:
            raise StorageError("Storage could not sign the upload")
        try:
            relative = response.json()["url"]
        except (ValueError, KeyError, TypeError):
            raise StorageError("Storage returned an invalid signed URL") from None
        return SignedUpload(storage_key=key, url=self._absolute(relative))

    def signed_download_url(self, key: str, *, expires_in: int = 300) -> str:
        response = self._request(
            "POST",
            f"/object/sign/{self.bucket}/{_object_path(key)}",
            json={"expiresIn": expires_in},
        )
        if response.status_code == 404 or response.status_code == 400 and "not found" in (
            response.text.lower()
        ):
            raise ObjectNotFoundError("Stored object is missing")
        if response.status_code >= 400:
            raise StorageError("Storage could not sign the download")
        try:
            relative = response.json()["signedURL"]
        except (ValueError, KeyError, TypeError):
            raise StorageError("Storage returned an invalid signed URL") from None
        return self._absolute(relative)

    def put(self, key: str, body: bytes) -> None:
        response = self._request(
            "POST",
            f"/object/{self.bucket}/{_object_path(key)}",
            content=body,
            headers={"Content-Type": CONTENT_TYPE, "x-upsert": "false"},
        )
        if response.status_code < 400:
            return
        # Keys are content-addressed, so an existing object already holds these bytes.
        if response.status_code == 409 or "duplicate" in response.text.lower():
            return
        raise StorageError("Storage rejected the upload")

    def get(self, key: str, *, max_bytes: int) -> StoredObject:
        url = f"{self._base}/object/authenticated/{self.bucket}/{_object_path(key)}"
        try:
            with self._http.stream("GET", url, headers=self._headers) as response:
                if response.status_code in {400, 404}:
                    raise ObjectNotFoundError("Stored object is missing")
                if response.status_code >= 400:
                    raise StorageError("Storage is unavailable")
                declared = response.headers.get("Content-Length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    raise ObjectTooLargeError("Stored object exceeds the size limit")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise ObjectTooLargeError("Stored object exceeds the size limit")
                modified = response.headers.get("Last-Modified")
        except httpx.HTTPError:
            raise StorageError("Storage is unavailable") from None
        last_modified = None
        if modified:
            try:
                last_modified = parsedate_to_datetime(modified)
            except (TypeError, ValueError):
                last_modified = None
        return StoredObject(body=bytes(body), last_modified=last_modified)

    def delete(self, keys: list[str]) -> None:
        if not keys:
            return
        response = self._request("DELETE", f"/object/{self.bucket}", json={"prefixes": keys})
        if response.status_code >= 400:
            raise StorageError("Storage could not delete objects")

