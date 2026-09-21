from __future__ import annotations

import json
import math
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

import pytest

import cekat_event_sdk
from cekat_event_sdk import Acknowledgement, Event, ValidationError
from cekat_event_sdk.validation import (
    build_body,
    normalize_origin,
    validate_access_token,
    validate_retry_count,
    validate_timeout,
    with_order_paid_properties,
)


class Plan(str, Enum):
    PRO = "pro"


FIXED = datetime(2026, 9, 13, 1, 15, 30, 250_999, tzinfo=timezone.utc)


def body(
    event: Event, key: str = "custom", is_common: bool = False, ambient: str | None = None
) -> dict[str, Any]:
    raw = build_body(key, is_common, event, ambient, now=lambda: FIXED, new_event_id=lambda: "generated-id")
    decoded: dict[str, Any] = json.loads(raw)
    return decoded


def test_package_exposes_initial_version_and_public_names() -> None:
    assert cekat_event_sdk.__version__ == "0.2.0"
    for name in cekat_event_sdk.__all__:
        assert hasattr(cekat_event_sdk, name)


def test_models_are_frozen() -> None:
    event = Event(email="a@example.test")
    with pytest.raises(FrozenInstanceError):
        event.email = "b@example.test"  # type: ignore[misc]
    ack = Acknowledgement(True, "queued", "k", ("a",), b"{}")
    with pytest.raises(FrozenInstanceError):
        ack.message = "changed"  # type: ignore[misc]


def test_payload_preserves_identity_and_adds_generated_fields() -> None:
    payload = body(
        Event(email=" a@example.test ", phone_number="", contact_name=" Ada ", properties={"n": 1})
    )
    assert payload == {
        "event_key": "custom",
        "event_id": "generated-id",
        "occurred_at": "2026-09-13T01:15:30.250Z",
        "is_common": False,
        "email": " a@example.test ",
        "phone_number": "",
        "contact_name": " Ada ",
        "properties": {"n": 1},
    }
    assert "business_id" not in payload


def test_explicit_event_id_is_trimmed_and_occurred_at_converted_to_utc() -> None:
    offset = timezone(timedelta(hours=7))
    payload = body(
        Event(
            email="a@example.test",
            event_id=" evt-checkout-123 ",
            occurred_at=datetime(2026, 9, 13, 8, 15, 30, 250_000, tzinfo=offset),
        )
    )
    assert payload["event_id"] == "evt-checkout-123"
    assert payload["occurred_at"] == "2026-09-13T01:15:30.250Z"
    assert body(Event(email="a", event_id="   "))["event_id"] == "generated-id"


def test_default_event_id_is_a_lowercase_uuid4() -> None:
    payload = json.loads(build_body("k", False, Event(email="a"), None))
    assert payload["event_id"] == payload["event_id"].lower()
    assert payload["event_id"][14] == "4"


def test_naive_occurred_at_is_rejected() -> None:
    with pytest.raises(ValidationError, match="timezone-aware"):
        body(Event(email="a", occurred_at=datetime(2026, 9, 13)))


@pytest.mark.parametrize(
    ("explicit", "ambient", "expected"),
    [
        (" explicit ", "ambient", "explicit"),
        ("  ", " ambient ", "ambient"),
        (None, None, None),
        ("", "  ", None),
    ],
)
def test_visitor_precedence(explicit: str | None, ambient: str | None, expected: str | None) -> None:
    payload = body(Event(email="a", visitor_id=explicit), ambient=ambient)
    assert payload.get("visitor_id") == expected


@pytest.mark.parametrize(
    ("key", "event", "match"),
    [
        ("  ", Event(email="a"), "event_key"),
        ("k", Event(email=" ", phone_number="\t"), "email or phone_number"),
        ("k", Event(), "email or phone_number"),
        ("k", Event(email=1), "email must be a string"),  # type: ignore[arg-type]
        ("k", "not an event", "cekat_event_sdk.Event"),
        ("k", Event(email="a", properties=[1]), "properties"),  # type: ignore[arg-type]
    ],
)
def test_invalid_events(key: str, event: Any, match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        build_body(key, False, event, None)


def test_properties_accept_json_values() -> None:
    shared = {"x": 1}
    properties = {
        "none": None,
        "flag": True,
        "text": "héllo",
        "int": 9_007_199_254_740_991,
        "negative": -9_007_199_254_740_991,
        "float": 1.5,
        "tiny_float": 1e-300,
        "decimal": Decimal("12.50"),
        "tuple": (1, "two"),
        "enum": Plan.PRO,
        "enum_keyed": {Plan.PRO: 1},
        "nested": {"list": [shared, shared]},
    }
    payload = body(Event(email="a", properties=properties))["properties"]
    assert payload["flag"] is True
    assert payload["enum"] == "pro"
    assert payload["enum_keyed"] == {"pro": 1}
    assert payload["decimal"] == 12.5
    assert payload["tuple"] == [1, "two"]
    assert payload["nested"] == {"list": [{"x": 1}, {"x": 1}]}


@pytest.mark.parametrize(
    "value",
    [
        math.nan,
        math.inf,
        -math.inf,
        9_007_199_254_740_992,
        -9_007_199_254_740_992,
        9_007_199_254_740_992.0,
        1e300,
        Decimal("NaN"),
        Decimal("Infinity"),
        object(),
        {1: "one"},
        {"a", "b"},
        b"bytes",
        datetime.now(timezone.utc),
        "\ud800",
    ],
)
def test_properties_reject_non_json_values(value: object) -> None:
    with pytest.raises(ValidationError) as caught:
        body(Event(email="a", properties={"value": value}))
    assert "secret" not in str(caught.value)


def test_properties_reject_cycles_and_deep_nesting() -> None:
    cycle: dict[str, Any] = {}
    cycle["self"] = cycle
    with pytest.raises(ValidationError, match="cycle"):
        body(Event(email="a", properties=cycle))
    listed: list[Any] = []
    listed.append(listed)
    with pytest.raises(ValidationError, match="cycle"):
        body(Event(email="a", properties={"list": listed}))
    deep: dict[str, Any] = {}
    cursor = deep
    for _ in range(300):
        cursor["next"] = {}
        cursor = cursor["next"]
    with pytest.raises(ValidationError, match="nested too deeply"):
        body(Event(email="a", properties=deep))


def test_validation_messages_do_not_echo_values() -> None:
    with pytest.raises(ValidationError) as caught:
        body(Event(email="a", properties={"card": {"number": math.nan}}))
    assert str(caught.value) == "properties.card.number is not a JSON-compatible value"


def test_order_paid_merges_amount_and_currency() -> None:
    event = with_order_paid_properties(125.75, " IDR ", Event(email="a", properties={"order_id": "o"}))
    assert body(event)["properties"] == {"order_id": "o", "amount": 125.75, "currency": " IDR "}
    assert (
        body(with_order_paid_properties(Decimal("10"), "USD", Event(email="a")))["properties"]["amount"] == 10
    )


@pytest.mark.parametrize(
    ("amount", "currency", "properties", "match"),
    [
        (math.nan, "IDR", None, "amount"),
        (math.inf, "IDR", None, "amount"),
        (Decimal("NaN"), "IDR", None, "amount"),
        (True, "IDR", None, "amount"),
        ("10", "IDR", None, "amount"),
        (10, "  ", None, "currency"),
        (10, None, None, "currency"),
        (10, "IDR", {"amount": 1}, '"amount"'),
        (10, "IDR", {"currency": "USD"}, '"currency"'),
    ],
)
def test_order_paid_rejects_invalid_arguments(
    amount: Any, currency: Any, properties: Any, match: str
) -> None:
    with pytest.raises(ValidationError, match=match):
        with_order_paid_properties(amount, currency, Event(email="a", properties=properties))


def test_order_paid_unsafe_integer_amount_fails_ordinary_property_rules() -> None:
    event = with_order_paid_properties(2**53, "IDR", Event(email="a"))
    with pytest.raises(ValidationError, match=r"properties\.amount"):
        body(event)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://server.cekat.ai", "https://server.cekat.ai"),
        ("HTTPS://Example.TEST:8443/", "https://example.test:8443"),
        ("http://127.0.0.1:1234", "http://127.0.0.1:1234"),
        ("http://[::1]:8080", "http://[::1]:8080"),
    ],
)
def test_origin_normalization(value: str, expected: str) -> None:
    assert normalize_origin(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "server.cekat.ai",
        "ftp://example.test",
        "https://user:pw@example.test",
        "https://example.test/api",
        "https://example.test?x=1",
        "https://example.test#f",
        "https://example.test:99999",
        None,
    ],
)
def test_origin_rejects_non_origins(value: Any) -> None:
    with pytest.raises(ValidationError, match="base_url"):
        normalize_origin(value)


def test_configuration_validation() -> None:
    assert validate_access_token("token") == "token"
    assert validate_timeout(1) == 1.0
    assert validate_retry_count(0) == 0
    for token in ("", "  ", None):
        with pytest.raises(ValidationError, match="access token"):
            validate_access_token(token)
    for timeout in (0, -1, math.inf, math.nan, True, "3"):
        with pytest.raises(ValidationError, match="timeout"):
            validate_timeout(timeout)
    for retry_count in (-1, 1.5, True, "2"):
        with pytest.raises(ValidationError, match="retry_count"):
            validate_retry_count(retry_count)
