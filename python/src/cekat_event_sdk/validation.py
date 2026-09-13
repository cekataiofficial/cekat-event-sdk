"""Configuration and event validation, and JSON request body construction."""

from __future__ import annotations

import json
import math
import uuid
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from .context import normalize_visitor_id
from .errors import ValidationError
from .models import Event

MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_DEPTH = 256
_RESERVED_ORDER_PAID = ("amount", "currency")


def validate_access_token(access_token: object) -> str:
    if not isinstance(access_token, str) or not access_token.strip():
        raise ValidationError("access token must be a non-empty string")
    return access_token


def normalize_origin(base_url: object) -> str:
    """Return ``scheme://host[:port]`` for an absolute HTTP(S) origin."""
    invalid = ValidationError(
        "base_url must be an absolute HTTP(S) origin without credentials, path, query, or fragment"
    )
    if not isinstance(base_url, str) or any(character in base_url for character in "?# \t\r\n"):
        raise invalid
    try:
        parts = urlsplit(base_url)
        port = parts.port
    except ValueError:
        raise invalid from None
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise invalid
    if parts.username is not None or parts.password is not None or parts.path not in {"", "/"}:
        raise invalid
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    return f"{parts.scheme.lower()}://{host}{f':{port}' if port is not None else ''}"


def validate_timeout(timeout: object) -> float:
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise ValidationError("timeout must be a finite number of seconds greater than zero")
    return float(timeout)


def validate_retry_count(retry_count: object) -> int:
    if isinstance(retry_count, bool) or not isinstance(retry_count, int) or retry_count < 0:
        raise ValidationError("retry_count must be a non-negative integer")
    return retry_count


def with_order_paid_properties(amount: object, currency: object, event: Event) -> Event:
    """Return a copy of ``event`` whose properties include the order_paid arguments."""
    if (
        isinstance(amount, bool)
        or not isinstance(amount, (int, float, Decimal))
        or (not isinstance(amount, int) and not math.isfinite(amount))
    ):
        raise ValidationError("amount must be a finite number")
    if not isinstance(currency, str) or not currency.strip():
        raise ValidationError("currency must be a non-empty string")
    if not isinstance(event, Event):
        raise ValidationError("event must be a cekat_event_sdk.Event")
    if event.properties is not None and not isinstance(event.properties, Mapping):
        raise ValidationError("properties must be a dict with string keys")
    properties = dict(event.properties or {})
    for reserved in _RESERVED_ORDER_PAID:
        if reserved in properties:
            raise ValidationError(
                f'properties must not contain "{reserved}"; pass it as the order_paid argument'
            )
    properties["amount"] = amount
    properties["currency"] = currency
    return replace(event, properties=properties)


def build_body(
    event_key: object,
    is_common: bool,
    event: object,
    ambient_visitor_id: str | None,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    new_event_id: Callable[[], str] = lambda: str(uuid.uuid4()),
) -> bytes:
    """Validate the event and return the UTF-8 JSON request body."""
    if not isinstance(event_key, str) or not event_key.strip():
        raise ValidationError("event_key must be a non-empty string")
    if not isinstance(event, Event):
        raise ValidationError("event must be a cekat_event_sdk.Event")
    for field in ("email", "phone_number", "contact_name", "visitor_id", "event_id"):
        value = getattr(event, field)
        if value is not None and not isinstance(value, str):
            raise ValidationError(f"{field} must be a string")
    if not (event.email or "").strip() and not (event.phone_number or "").strip():
        raise ValidationError("at least one non-empty email or phone_number is required")

    payload: dict[str, Any] = {
        "event_key": event_key,
        "event_id": normalize_visitor_id(event.event_id) or new_event_id(),
        "occurred_at": _occurred_at(event.occurred_at, now),
        "is_common": is_common,
    }
    for name in ("email", "phone_number", "contact_name"):
        value = getattr(event, name)
        if value is not None:
            payload[name] = value
    visitor_id = normalize_visitor_id(event.visitor_id) or normalize_visitor_id(ambient_visitor_id)
    if visitor_id:
        payload["visitor_id"] = visitor_id
    if event.properties is not None:
        if not isinstance(event.properties, Mapping):
            raise ValidationError("properties must be a dict with string keys")
        payload["properties"] = _normalize(event.properties, "properties", set(), 0)
    try:
        return json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (UnicodeEncodeError, ValueError):
        raise ValidationError("event is not JSON-compatible; strings must be valid Unicode") from None


def _occurred_at(value: object, now: Callable[[], datetime]) -> str:
    moment = now() if value is None else value
    if not isinstance(moment, datetime):
        raise ValidationError("occurred_at must be a datetime")
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValidationError("occurred_at must be timezone-aware")
    try:
        utc = moment.astimezone(timezone.utc)
    except OverflowError:
        raise ValidationError("occurred_at must be between years 0001 and 9999") from None
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def _normalize(value: object, path: str, ancestors: set[int], depth: int) -> Any:
    if depth > _MAX_DEPTH:
        raise ValidationError(f"{path} is nested too deeply")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        _check_unicode(value, path)
        return str.__str__(value)
    if isinstance(value, int):
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise _invalid(path)
        return int(value)
    if isinstance(value, (float, Decimal)):
        if isinstance(value, Decimal) and not value.is_finite():
            raise _invalid(path)
        number = float(value)
        if not math.isfinite(number) or (number.is_integer() and abs(number) > MAX_SAFE_INTEGER):
            raise _invalid(path)
        return number
    if isinstance(value, Mapping):
        return _container(value, path, ancestors, depth)
    if isinstance(value, (list, tuple)):
        return _container(value, path, ancestors, depth)
    raise _invalid(path)


def _container(
    value: Mapping[Any, Any] | list[Any] | tuple[Any, ...], path: str, ancestors: set[int], depth: int
) -> Any:
    identity = id(value)
    if identity in ancestors:
        raise ValidationError(f"{path} contains a cycle")
    ancestors.add(identity)
    try:
        if isinstance(value, Mapping):
            result: dict[str, Any] = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValidationError(f"{path} has a non-string key; property keys must be strings")
                _check_unicode(key, path)
                child = f"{path}.{key}" if key else f'{path}[""]'
                result[str.__str__(key)] = _normalize(item, child, ancestors, depth + 1)
            return result
        return [
            _normalize(item, f"{path}[{index}]", ancestors, depth + 1) for index, item in enumerate(value)
        ]
    finally:
        ancestors.discard(identity)


def _check_unicode(value: str, path: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValidationError(f"{path} must be valid Unicode") from None


def _invalid(path: str) -> ValidationError:
    return ValidationError(f"{path} is not a JSON-compatible value")
