"""Synchronous client."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from decimal import Decimal
from types import TracebackType

import httpx

from ._shared import (
    DEFAULT_BASE_URL,
    DEFAULT_RETRY_COUNT,
    DEFAULT_TIMEOUT,
    Settings,
    body_timeout,
    received,
    transport_error,
)
from .context import current_visitor_id
from .errors import ValidationError
from .models import Acknowledgement, Event
from .protocol import BoundedBuffer, ReceivedResponse, decode
from .retry import is_retryable_status, retry_delay
from .validation import build_body, with_order_paid_properties


class Client:
    """Blocking Cekat event client. Thread-safe; share one instance per process.

    An injected ``http_client`` stays owned by the caller and is never closed by the SDK.
    """

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        retry_count: int = DEFAULT_RETRY_COUNT,
        http_client: httpx.Client | None = None,
        _sleep: Callable[[float], None] = time.sleep,
        _uniform: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._settings = Settings.create(access_token, base_url, timeout, retry_count)
        if http_client is not None and not isinstance(http_client, httpx.Client):
            raise ValidationError("http_client must be an httpx.Client")
        self._owns_http = http_client is None
        self._http = http_client if http_client is not None else httpx.Client()
        self._sleep = _sleep
        self._uniform = _uniform

    def __repr__(self) -> str:
        return f"Client(url={self._settings.url!r})"

    def user_registration(self, event: Event) -> Acknowledgement:
        return self._track("user_registration", True, event)

    def user_login(self, event: Event) -> Acknowledgement:
        return self._track("user_login", True, event)

    def order_created(self, event: Event) -> Acknowledgement:
        return self._track("order_created", True, event)

    def form_submitted(self, event: Event) -> Acknowledgement:
        return self._track("form_submitted", True, event)

    def order_paid(self, amount: float | int | Decimal, currency: str, event: Event) -> Acknowledgement:
        """Track ``order_paid``; ``amount`` and ``currency`` are sent as properties."""
        return self._track("order_paid", True, with_order_paid_properties(amount, currency, event))

    def custom_event(self, event_key: str, event: Event) -> Acknowledgement:
        return self._track(event_key, False, event)

    def close(self) -> None:
        """Close the SDK-created HTTP client. Injected clients are left open."""
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()

    def _track(self, event_key: str, is_common: bool, event: Event) -> Acknowledgement:
        body = build_body(event_key, is_common, event, current_visitor_id())
        attempts = 0
        while True:
            attempts += 1
            try:
                response = self._attempt(body)
            except httpx.TransportError as error:
                if attempts > self._settings.retry_count:
                    raise transport_error(error, attempts) from error
                self._sleep(retry_delay(attempts, None, self._uniform) or 0.0)
                continue
            if is_retryable_status(response.status_code) and attempts <= self._settings.retry_count:
                delay = retry_delay(attempts, response.header("Retry-After"), self._uniform)
                if delay is not None:
                    self._sleep(delay)
                    continue
            return decode(response, attempts)

    def _attempt(self, body: bytes) -> ReceivedResponse:
        settings = self._settings
        deadline = time.monotonic() + settings.timeout
        request = self._http.build_request(
            "POST", settings.url, content=body, headers=list(settings.headers), timeout=settings.timeout
        )
        response = self._http.send(request, stream=True, follow_redirects=False)
        buffer = BoundedBuffer()
        failure: BaseException | None = None
        try:
            for chunk in response.iter_bytes():
                if not buffer.append(chunk):
                    break
                if time.monotonic() > deadline:
                    raise body_timeout(settings.timeout)
        except httpx.HTTPError as error:
            failure = error
        finally:
            response.close()
        return received(response, buffer, failure)
