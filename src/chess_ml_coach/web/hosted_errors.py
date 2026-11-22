"""Translate hosted domain errors into public API errors."""

from collections.abc import Iterator
from contextlib import contextmanager

from ..chesscom import ChessComError, ChessComNotFoundError
from ..hosted.checkpoint_validation import CheckpointRejectedError, UploadTooLargeError
from ..hosted.checkpoints import IncompleteJobError, SequenceConflictError
from ..hosted.jobs import JobError, JobNotFoundError
from ..hosted.leases import (
    InvalidDeviceError,
    LeaseError,
    LeaseLostError,
    LeaseUnavailableError,
    ObserverOnlyError,
)
from ..hosted.manifests import EmptyManifestError, ManifestError
from ..hosted.profiles import (
    InvalidUsernameError,
    NotEntitledError,
    PaidSubscriptionRequiredError,
    ProfileError,
    ProfileLimitError,
    UnknownPlayerError,
)
from ..hosted.rate_limit import RateLimitedError
from ..hosted.storage import ObjectNotFoundError, StorageError
from ..hosted.sync import SyncBusyError


class HostedApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


_STATUS_BY_TYPE: tuple[tuple[type[Exception], int], ...] = (
    (InvalidUsernameError, 422),
    (UnknownPlayerError, 404),
    (PaidSubscriptionRequiredError, 402),
    (ProfileLimitError, 409),
    (NotEntitledError, 403),
    (ProfileError, 400),
    (JobNotFoundError, 404),
    (JobError, 409),
    (InvalidDeviceError, 422),
    (ObserverOnlyError, 403),
    (LeaseUnavailableError, 409),
    (LeaseLostError, 409),
    (LeaseError, 409),
    (UploadTooLargeError, 413),
    (SequenceConflictError, 409),
    (IncompleteJobError, 409),
    (CheckpointRejectedError, 422),
    (EmptyManifestError, 422),
    (ManifestError, 422),
    (RateLimitedError, 429),
    (SyncBusyError, 409),
    (ObjectNotFoundError, 404),
    (StorageError, 502),
    (ChessComNotFoundError, 404),
    (ChessComError, 502),
)
_PUBLIC_MESSAGES = {
    StorageError: "Result storage is temporarily unavailable",
    ChessComError: "Chess.com is temporarily unavailable",
}


def _translate(exc: Exception) -> HostedApiError:
    for kind, status in _STATUS_BY_TYPE:
        if isinstance(exc, kind):
            message = str(exc)
            for public_kind, public in _PUBLIC_MESSAGES.items():
                if isinstance(exc, public_kind) and not isinstance(exc, ChessComNotFoundError):
                    message = public
            return HostedApiError(status, getattr(exc, "code", "error"), message)
    raise exc


_DOMAIN_ERRORS = tuple(kind for kind, _ in _STATUS_BY_TYPE)


@contextmanager
def translate_hosted_errors() -> Iterator[None]:
    try:
        yield
    except _DOMAIN_ERRORS as exc:
        raise _translate(exc) from None
