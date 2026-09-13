"""Pure retry decisions: retryable statuses, full-jitter bounds, and ``Retry-After`` parsing."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})
MAXIMUM_RETRY_AFTER_SECONDS = 5.0
_HTTP_DATE = re.compile(
    r"[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT"  # IMF-fixdate
    r"|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT"  # RFC 850
    r"|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}"  # asctime
)


def is_retryable_status(status_code: int) -> bool:
    return status_code in RETRYABLE_STATUSES


def jitter_upper_bound(retry_number: int) -> float:
    """Full-jitter upper bound in seconds before one-indexed retry ``retry_number``."""
    return min(0.1 * float(2 ** (min(max(retry_number, 1), 5) - 1)), 1.0)


def parse_retry_after(value: str | None, now: datetime | None = None) -> float | None:
    """Return the ``Retry-After`` delay in seconds, or ``None`` when absent or invalid."""
    text = (value or "").strip()
    if not text:
        return None
    if text.isascii() and text.isdigit():
        return float("inf") if len(text) > 9 else float(text)
    if not _HTTP_DATE.fullmatch(text):
        return None
    try:
        date = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    return max(0.0, (date - (now or datetime.now(timezone.utc))).total_seconds())


def retry_delay(
    retry_number: int, retry_after: str | None, uniform: Callable[[float, float], float]
) -> float | None:
    """Return the delay before a retry, or ``None`` when ``Retry-After`` exceeds the 5 second cap."""
    requested = parse_retry_after(retry_after)
    if requested is not None and requested > MAXIMUM_RETRY_AFTER_SECONDS:
        return None
    return max(uniform(0.0, jitter_upper_bound(retry_number)), requested or 0.0)
