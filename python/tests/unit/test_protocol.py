from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from cekat_event_sdk import ApiError, AuthenticationError, EventDefinitionNotFoundError, ResponseDecodeError
from cekat_event_sdk.protocol import MAX_RESPONSE_BYTES, BoundedBuffer, ReceivedResponse, decode
from cekat_event_sdk.retry import jitter_upper_bound, parse_retry_after, retry_delay

VALID = {
    "success": True,
    "data": {"success": True, "message": "queued", "event_key": "k", "validated_properties": ["a"]},
}


def response(status: int, body: bytes | str, reason: str = "", **extra: object) -> ReceivedResponse:
    raw = body.encode() if isinstance(body, str) else body
    return ReceivedResponse(status, reason, (), raw, **extra)  # type: ignore[arg-type]


def test_valid_acknowledgement_ignores_extra_fields() -> None:
    envelope = json.loads(json.dumps(VALID))
    envelope["extra"] = 1
    envelope["data"]["more"] = {"x": 1}
    raw = json.dumps(envelope)
    ack = decode(response(200, raw), 1)
    assert (ack.success, ack.message, ack.event_key, ack.validated_properties) == (
        True,
        "queued",
        "k",
        ("a",),
    )
    assert ack.raw_body == raw.encode()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda v: v.__setitem__("success", 1),
        lambda v: v.__setitem__("data", []),
        lambda v: v["data"].__setitem__("success", "true"),
        lambda v: v["data"].pop("success"),
        lambda v: v["data"].__setitem__("message", ""),
        lambda v: v["data"].__setitem__("event_key", None),
        lambda v: v["data"].__setitem__("validated_properties", {"a": 1}),
        lambda v: v["data"].__setitem__("validated_properties", ["a", 1]),
    ],
)
def test_invalid_success_envelopes(mutate: object) -> None:
    envelope = json.loads(json.dumps(VALID))
    mutate(envelope)  # type: ignore[operator]
    with pytest.raises(ResponseDecodeError) as caught:
        decode(response(200, json.dumps(envelope)), 2)
    assert caught.value.attempts == 2
    assert caught.value.status_code == 200
    assert caught.value.delivery_outcome_unknown is False


def test_success_body_failures_are_decode_errors() -> None:
    with pytest.raises(ResponseDecodeError, match="could not be read"):
        decode(response(200, b'{"success":tr', body_read_failure=OSError("reset")), 1)
    with pytest.raises(ResponseDecodeError, match="exceeds"):
        decode(response(200, b"x" * MAX_RESPONSE_BYTES, body_truncated=True), 1)
    with pytest.raises(ResponseDecodeError):
        decode(response(200, b"\xff\xfe"), 1)


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(401, AuthenticationError), (404, EventDefinitionNotFoundError), (400, ApiError), (500, ApiError)],
)
def test_structured_errors(status: int, error_type: type[ApiError]) -> None:
    raw = '{"success":false,"error":"nope","code":"bad_thing"}'
    with pytest.raises(error_type) as caught:
        decode(response(status, raw, "Ignored"), 3)
    error = caught.value
    assert (error.status_code, error.message, error.code, error.raw_body, error.attempts) == (
        status,
        "nope",
        "bad_thing",
        raw.encode(),
        3,
    )
    assert error.delivery_outcome_unknown is False


@pytest.mark.parametrize(
    ("body", "reason", "status", "message"),
    [
        ("not json", "", 418, "I'm a teapot"),
        ('{"success":false,"error":""}', "", 422, "Unprocessable Content"),
        ('{"success":false,"error":"x","code":5}', "", 413, "Content Too Large"),
        ('{"success":true,"error":"x"}', "Custom Reason", 400, "Custom Reason"),
        ("", "", 599, "HTTP 599"),
    ],
)
def test_error_message_fallbacks(body: str, reason: str, status: int, message: str) -> None:
    with pytest.raises(ApiError) as caught:
        decode(response(status, body, reason), 1)
    assert caught.value.message == message
    assert caught.value.code is None


def test_bounded_buffer_keeps_sentinel() -> None:
    buffer = BoundedBuffer()
    assert buffer.append(b"a" * MAX_RESPONSE_BYTES)
    assert not buffer.append(b"bc")
    result = buffer.response(200, "OK", (), OSError("ignored when truncated"))
    assert (len(result.body), result.observed_body_bytes, result.body_truncated) == (
        MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES + 1,
        True,
    )
    assert result.body_read_failure is None


def test_jitter_bounds() -> None:
    assert [jitter_upper_bound(n) for n in range(1, 8)] == [0.1, 0.2, 0.4, 0.8, 1.0, 1.0, 1.0]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("0", 0.0),
        (" 3 ", 3.0),
        ("99999999999999999999", float("inf")),
        ("-1", None),
        ("1.5", None),
        ("soon", None),
        ("", None),
        (None, None),
        ("Sun, 13 Sep 2026 00:00:02 GMT", 2.0),
        ("Sunday, 13-Sep-26 00:00:04 GMT", 4.0),
        ("Sun Sep 13 00:00:01 2026", 1.0),
        ("Sat, 12 Sep 2026 23:00:00 GMT", 0.0),
        ("Sun, 13 Sep 2026 00:00:02 +0000", None),
    ],
)
def test_parse_retry_after(value: str | None, expected: float | None) -> None:
    now = datetime(2026, 9, 13, tzinfo=timezone.utc)
    assert parse_retry_after(value, now) == expected


def test_retry_delay_combines_jitter_and_retry_after() -> None:
    assert retry_delay(2, None, lambda low, high: high) == 0.2
    assert retry_delay(1, "1", lambda low, high: high) == 1.0
    assert retry_delay(5, "0", lambda low, high: high) == 1.0
    assert retry_delay(1, "5", lambda low, high: low) == 5.0
    assert retry_delay(1, "6", lambda low, high: low) is None
    assert retry_delay(1, "garbage", lambda low, high: low) == 0.0
