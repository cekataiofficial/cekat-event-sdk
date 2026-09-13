"""Typed errors raised by the SDK. Messages never contain the access token."""

from __future__ import annotations

from typing import ClassVar


class CekatError(Exception):
    """Base class for every SDK error."""

    attempts: int = 0
    delivery_outcome_unknown: ClassVar[bool] = False

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ValidationError(CekatError):
    """Invalid configuration or event input, detected before any request."""


class HttpError(CekatError):
    """Cekat returned a non-200 response; the delivery outcome is known."""

    def __init__(
        self, *, status_code: int, message: str, code: str | None, raw_body: bytes, attempts: int
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.raw_body = bytes(raw_body)
        self.attempts = attempts

    def __repr__(self) -> str:
        name = type(self).__name__
        return f"{name}(status_code={self.status_code}, message={self.message!r}, attempts={self.attempts})"


class AuthenticationError(HttpError):
    """HTTP 401: Cekat rejected the access token."""


class EventDefinitionNotFoundError(HttpError):
    """HTTP 404: the tenant has no definition for the event key."""


class ApiError(HttpError):
    """Any other non-200 response, including exhausted retryable statuses."""


class TransportError(CekatError):
    """No response was received after all attempts.

    Cekat may still have received the event, so resending it can create a duplicate.
    """

    delivery_outcome_unknown: ClassVar[bool] = True

    def __init__(self, message: str, *, attempts: int, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.cause = cause

    def __repr__(self) -> str:
        return f"TransportError(message={self.message!r}, attempts={self.attempts})"


class ResponseDecodeError(CekatError):
    """HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received."""

    def __init__(
        self, message: str, *, raw_body: bytes, attempts: int, cause: BaseException | None = None
    ) -> None:
        super().__init__(message)
        self.status_code = 200
        self.raw_body = bytes(raw_body)
        self.attempts = attempts
        self.cause = cause

    def __repr__(self) -> str:
        return f"ResponseDecodeError(message={self.message!r}, attempts={self.attempts})"
