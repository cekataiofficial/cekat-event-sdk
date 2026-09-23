"""Configuration and per-attempt helpers shared by the synchronous and asynchronous clients."""

from __future__ import annotations

import platform
from dataclasses import dataclass

import httpx

from ._version import __version__
from .errors import TransportError
from .protocol import BoundedBuffer, ReceivedResponse
from .validation import normalize_origin, validate_access_token, validate_retry_count, validate_timeout

DEFAULT_BASE_URL = "https://t.cekat.ai"
DEFAULT_TIMEOUT = 3.0
DEFAULT_RETRY_COUNT = 2
INGEST_PATH = "/api/events/ingest"
USER_AGENT = f"cekat-event-sdk-python/{__version__} python/{platform.python_version()}"


@dataclass(frozen=True, slots=True)
class Settings:
    url: str
    headers: tuple[tuple[str, str], ...]
    timeout: float
    retry_count: int

    @classmethod
    def create(cls, access_token: object, base_url: object, timeout: object, retry_count: object) -> Settings:
        token = validate_access_token(access_token)
        return cls(
            url=normalize_origin(base_url) + INGEST_PATH,
            headers=(
                ("Authorization", f"Bearer {token}"),
                ("Content-Type", "application/json"),
                ("Accept", "application/json"),
                ("User-Agent", USER_AGENT),
            ),
            timeout=validate_timeout(timeout),
            retry_count=validate_retry_count(retry_count),
        )

    def __repr__(self) -> str:
        return f"Settings(url={self.url!r}, timeout={self.timeout}, retry_count={self.retry_count})"


def received(
    response: httpx.Response, buffer: BoundedBuffer, failure: BaseException | None
) -> ReceivedResponse:
    return buffer.response(
        response.status_code,
        response.reason_phrase,
        tuple((name, value) for name, value in response.headers.multi_items()),
        failure,
    )


def body_timeout(timeout: float) -> httpx.ReadTimeout:
    return httpx.ReadTimeout(f"response body was not received within {timeout:g} seconds")


def transport_error(cause: httpx.TransportError, attempts: int) -> TransportError:
    noun = "attempt" if attempts == 1 else "attempts"
    return TransportError(
        f"no response from Cekat after {attempts} {noun} ({type(cause).__name__}); "
        "the event may have been received",
        attempts=attempts,
        cause=cause,
    )
