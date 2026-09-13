from __future__ import annotations

import platform
from collections.abc import Callable

import httpx
import pytest

from cekat_event_sdk import (
    ApiError,
    AuthenticationError,
    Client,
    Event,
    EventDefinitionNotFoundError,
    ResponseDecodeError,
    TransportError,
    ValidationError,
    visitor_scope,
)
from tests.support import Chunks, InterruptedStream, failure, ok, payload

TOKEN = "super-secret-token"
Handler = Callable[[httpx.Request], httpx.Response]


class Harness:
    def __init__(
        self, *responses: httpx.Response | Exception, retry_count: int = 2, timeout: float = 3.0
    ) -> None:
        self.queue = list(responses)
        self.requests: list[httpx.Request] = []
        self.sleeps: list[float] = []
        self.http = httpx.Client(transport=httpx.MockTransport(self.handle))
        self.sdk = Client(
            TOKEN,
            base_url="https://example.test/",
            timeout=timeout,
            retry_count=retry_count,
            http_client=self.http,
            _sleep=self.sleeps.append,
            _uniform=lambda low, high: high,
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_common_method_sends_expected_request() -> None:
    harness = Harness(ok("order_paid"))
    ack = harness.sdk.order_paid(125.75, "IDR", Event(email=" a@example.test ", properties={"n": 1}))
    assert ack.event_key == "order_paid"
    (request,) = harness.requests
    assert request.method == "POST"
    assert str(request.url) == "https://example.test/api/events/ingest"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["content-type"] == "application/json"
    assert request.headers.get_list("user-agent") == [
        f"cekat-event-sdk-python/0.1.0 python/{platform.python_version()}"
    ]
    body = payload(request)
    assert body["email"] == " a@example.test "
    assert body["is_common"] is True
    assert body["properties"] == {"n": 1, "amount": 125.75, "currency": "IDR"}


@pytest.mark.parametrize(
    ("method", "key", "is_common"),
    [
        ("user_registration", "user_registration", True),
        ("user_login", "user_login", True),
        ("order_created", "order_created", True),
    ],
)
def test_fixed_key_methods(method: str, key: str, is_common: bool) -> None:
    harness = Harness(ok(key))
    getattr(harness.sdk, method)(Event(phone_number="+62"))
    assert payload(harness.requests[0])["event_key"] == key
    assert payload(harness.requests[0])["is_common"] is is_common


def test_custom_event_uses_ambient_visitor() -> None:
    harness = Harness(ok())
    with visitor_scope(" visitor "):
        harness.sdk.custom_event("signup_step", Event(email="a"))
    body = payload(harness.requests[0])
    assert (body["event_key"], body["is_common"], body["visitor_id"]) == ("signup_step", False, "visitor")


def test_validation_fails_before_network() -> None:
    harness = Harness()
    with pytest.raises(ValidationError):
        harness.sdk.custom_event("k", Event())
    with pytest.raises(ValidationError):
        harness.sdk.order_paid(float("nan"), "IDR", Event(email="a"))
    assert harness.requests == []


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_retryable_statuses_retry_with_same_event_identity(status: int) -> None:
    harness = Harness(failure(status), failure(status), ok())
    assert harness.sdk.custom_event("k", Event(email="a")).success
    assert len(harness.requests) == 3
    assert harness.sleeps == [0.1, 0.2]
    first, second, third = (payload(request) for request in harness.requests)
    assert first == second == third


def test_exhausted_retries_raise_last_status() -> None:
    harness = Harness(failure(502), failure(503), failure(504))
    with pytest.raises(ApiError) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    assert (caught.value.status_code, caught.value.attempts, caught.value.message) == (504, 3, "failed 504")


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(400, ApiError), (401, AuthenticationError), (404, EventDefinitionNotFoundError), (409, ApiError)],
)
def test_non_retryable_statuses(status: int, error_type: type[ApiError]) -> None:
    harness = Harness(failure(status), ok())
    with pytest.raises(error_type) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    assert caught.value.attempts == 1
    assert harness.sleeps == []


def test_retry_after_raises_delay_and_long_values_stop_retrying() -> None:
    harness = Harness(failure(429, {"Retry-After": "2"}), failure(503, {"Retry-After": "6"}), ok())
    with pytest.raises(ApiError) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    assert harness.sleeps == [2.0]
    assert (caught.value.status_code, caught.value.attempts) == (503, 2)


def test_transport_errors_retry_then_raise_unknown_outcome() -> None:
    harness = Harness(
        httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("closed")
    )
    with pytest.raises(TransportError) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    error = caught.value
    assert (error.attempts, error.delivery_outcome_unknown) == (3, True)
    assert isinstance(error.cause, httpx.RemoteProtocolError)
    assert error.__cause__ is error.cause
    assert harness.sleeps == [0.1, 0.2]
    for text in (str(error), repr(error)):
        assert TOKEN not in text


def test_zero_retry_count_makes_one_attempt() -> None:
    harness = Harness(failure(500), retry_count=0)
    with pytest.raises(ApiError):
        harness.sdk.custom_event("k", Event(email="a"))
    assert len(harness.requests) == 1


def test_interrupted_success_body_is_not_retried() -> None:
    harness = Harness(httpx.Response(200, stream=InterruptedStream(b'{"success":tr')), ok())
    with pytest.raises(ResponseDecodeError) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    assert caught.value.attempts == 1
    assert caught.value.raw_body == b'{"success":tr'
    assert isinstance(caught.value.cause, httpx.ReadError)
    assert len(harness.requests) == 1


def test_interrupted_retryable_body_is_retried_by_status() -> None:
    harness = Harness(httpx.Response(500, stream=InterruptedStream(b'{"succ')), ok())
    assert harness.sdk.custom_event("k", Event(email="a")).success
    assert len(harness.requests) == 2


def test_error_body_is_bounded_and_stream_stops_after_sentinel() -> None:
    stream = Chunks(b"a" * 65_000, b"b" * 536, b"c" * 10, b"never read")
    harness = Harness(httpx.Response(400, stream=stream))
    with pytest.raises(ApiError) as caught:
        harness.sdk.custom_event("k", Event(email="a"))
    assert len(caught.value.raw_body) == 65_536
    assert caught.value.message == "Bad Request"
    assert stream.consumed == 3


def test_reason_phrase_is_used_for_malformed_errors() -> None:
    harness = Harness(httpx.Response(400, content=b"<html>", extensions={"reason_phrase": b"Nope"}))
    with pytest.raises(ApiError, match="Nope"):
        harness.sdk.custom_event("k", Event(email="a"))


def test_injected_client_is_not_closed_and_owned_client_is() -> None:
    harness = Harness(ok())
    with harness.sdk as sdk:
        sdk.custom_event("k", Event(email="a"))
    assert not harness.http.is_closed
    owned = Client(TOKEN)
    with owned:
        pass
    assert owned._http.is_closed


def test_constructor_validation_and_repr_hide_token() -> None:
    with pytest.raises(ValidationError):
        Client("")
    with pytest.raises(ValidationError):
        Client(TOKEN, base_url="https://example.test/path")
    with pytest.raises(ValidationError):
        Client(TOKEN, http_client=httpx.AsyncClient())  # type: ignore[arg-type]
    sdk = Client(TOKEN)
    assert TOKEN not in repr(sdk)
    assert TOKEN not in repr(sdk._settings)
    sdk.close()


def test_slow_body_exceeding_timeout_is_a_timeout() -> None:
    class Slow(httpx.SyncByteStream):
        def __iter__(self):  # type: ignore[no-untyped-def]
            import time

            yield b'{"success"'
            time.sleep(0.05)
            yield b":true}"

    harness = Harness(httpx.Response(500, stream=Slow()), ok(), timeout=0.01)
    assert harness.sdk.custom_event("k", Event(email="a")).success
    assert len(harness.requests) == 2
