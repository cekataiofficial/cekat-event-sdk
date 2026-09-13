"""Bounded response capture and envelope/status decoding shared by both clients."""

from __future__ import annotations

import json
from dataclasses import dataclass

from .errors import (
    ApiError,
    AuthenticationError,
    EventDefinitionNotFoundError,
    HttpError,
    ResponseDecodeError,
)
from .models import Acknowledgement

MAX_RESPONSE_BYTES = 65_536
# Fixed across Python versions so every SDK reports the same fallback message.
_STATUS_TEXT = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    413: "Content Too Large",
    415: "Unsupported Media Type",
    418: "I'm a teapot",
    422: "Unprocessable Content",
    429: "Too Many Requests",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
}


@dataclass(frozen=True, slots=True)
class ReceivedResponse:
    """A response whose status arrived. ``body`` holds at most 65,536 bytes."""

    status_code: int
    reason_phrase: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    body_truncated: bool = False
    observed_body_bytes: int = 0
    body_read_failure: BaseException | None = None

    def header(self, name: str) -> str | None:
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None


class BoundedBuffer:
    """Keeps the retained prefix plus one sentinel byte that proves truncation."""

    def __init__(self) -> None:
        self._data = bytearray()

    def append(self, chunk: bytes) -> bool:
        """Append ``chunk``; return ``False`` once the sentinel byte has been observed."""
        room = MAX_RESPONSE_BYTES + 1 - len(self._data)
        if room > 0:
            self._data += chunk[:room]
        return len(self._data) <= MAX_RESPONSE_BYTES

    def response(
        self,
        status_code: int,
        reason_phrase: str,
        headers: tuple[tuple[str, str], ...],
        failure: BaseException | None,
    ) -> ReceivedResponse:
        truncated = len(self._data) > MAX_RESPONSE_BYTES
        return ReceivedResponse(
            status_code=status_code,
            reason_phrase=reason_phrase,
            headers=headers,
            body=bytes(self._data[:MAX_RESPONSE_BYTES]),
            body_truncated=truncated,
            observed_body_bytes=len(self._data),
            body_read_failure=None if truncated else failure,
        )


def decode(response: ReceivedResponse, attempts: int) -> Acknowledgement:
    """Return the acknowledgement for a valid 200 or raise the typed error for the response."""
    if response.status_code == 200:
        return _acknowledgement(response, attempts)
    message: str | None = None
    code: str | None = None
    envelope = _parse(response.body)
    if (
        isinstance(envelope, dict)
        and envelope.get("success") is False
        and isinstance(envelope.get("error"), str)
        and envelope["error"]
        and ("code" not in envelope or isinstance(envelope["code"], str))
    ):
        message, code = envelope["error"], envelope.get("code")
    if message is None:
        message = response.reason_phrase.strip() or _status_text(response.status_code)
    error_type: type[HttpError] = {401: AuthenticationError, 404: EventDefinitionNotFoundError}.get(
        response.status_code, ApiError
    )
    raise error_type(
        status_code=response.status_code,
        message=message,
        code=code,
        raw_body=response.body,
        attempts=attempts,
    )


def _acknowledgement(response: ReceivedResponse, attempts: int) -> Acknowledgement:
    body = response.body
    if response.body_read_failure is not None:
        raise ResponseDecodeError(
            "response body could not be read",
            raw_body=body,
            attempts=attempts,
            cause=response.body_read_failure,
        )
    if response.body_truncated:
        raise ResponseDecodeError(
            f"response body exceeds {MAX_RESPONSE_BYTES} bytes", raw_body=body, attempts=attempts
        )
    envelope = _parse(body)
    data = envelope.get("data") if isinstance(envelope, dict) else None
    properties = data.get("validated_properties") if isinstance(data, dict) else None
    if (
        isinstance(envelope, dict)
        and envelope.get("success") is True
        and isinstance(data, dict)
        and data.get("success") is True
        and isinstance(data.get("message"), str)
        and data["message"]
        and isinstance(data.get("event_key"), str)
        and data["event_key"]
        and isinstance(properties, list)
        and all(isinstance(item, str) for item in properties)
    ):
        return Acknowledgement(
            success=True,
            message=data["message"],
            event_key=data["event_key"],
            validated_properties=tuple(properties),
            raw_body=body,
        )
    raise ResponseDecodeError(
        "response body is not a valid success envelope", raw_body=body, attempts=attempts
    )


def _parse(body: bytes) -> object:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _status_text(status_code: int) -> str:
    return _STATUS_TEXT.get(status_code, f"HTTP {status_code}")
