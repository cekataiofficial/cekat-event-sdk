"""Immutable event input and acknowledgement values."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class Event:
    """An identity-bearing event. At least one of ``email`` or ``phone_number`` must be nonblank.

    ``properties`` values may be ``None``, ``bool``, ``str``, finite ``int``/``float``/``Decimal``,
    lists, tuples, and dicts with ``str`` keys. Integers must be within ±(2**53 - 1).

    ``event_id`` lets Cekat deduplicate deliveries; when blank the SDK generates a random UUID and
    reuses it for every retry. ``occurred_at`` must be timezone-aware and defaults to the call time.
    """

    email: str | None = None
    phone_number: str | None = None
    contact_name: str | None = None
    visitor_id: str | None = None
    properties: Mapping[str, Any] | None = None
    event_id: str | None = None
    occurred_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Acknowledgement:
    """Cekat accepted the event for asynchronous processing.

    This does not confirm durable storage, identity resolution, delivery completion, or analytics
    availability.
    """

    success: bool
    message: str
    event_key: str
    validated_properties: tuple[str, ...]
    raw_body: bytes
