"""Request-local visitor scope backed by :class:`contextvars.ContextVar`.

The scope follows the current thread or asyncio task: tasks created inside a scope start with a
copy of it, and every scope restores the previous visitor when it exits. Visitor IDs are untrusted
correlation data; never use them for authentication or authorization.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar

VISITOR_HEADER = "X-Cekat-Visitor-ID"
VISITOR_COOKIE = "_cekat_visitor_id"

_current: ContextVar[str | None] = ContextVar("cekat_visitor_id", default=None)


def normalize_visitor_id(value: object) -> str | None:
    """Return the trimmed visitor ID, or ``None`` when blank or not a string."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def current_visitor_id() -> str | None:
    """Return the visitor ID of the current scope."""
    return _current.get()


@contextmanager
def visitor_scope(visitor_id: str | None) -> Iterator[None]:
    """Run the ``with`` block with ``visitor_id`` (trimmed; blank means none) as the current visitor."""
    token = _current.set(normalize_visitor_id(visitor_id))
    try:
        yield
    finally:
        _current.reset(token)


def visitor_id_from_cookie_header(cookie_header: str | None) -> str | None:
    """Return the first nonblank ``_cekat_visitor_id`` value in a raw Cookie header, undecoded."""
    if not cookie_header:
        return None
    for pair in cookie_header.split(";"):
        name, separator, value = pair.partition("=")
        if separator and name.strip() == VISITOR_COOKIE:
            visitor_id = normalize_visitor_id(value)
            if visitor_id:
                return visitor_id
    return None


def extract_visitor_id(
    headers: Mapping[str, str] | Iterable[tuple[str, str]], cookies: Mapping[str, str] | None = None
) -> str | None:
    """Resolve the visitor: a nonblank header wins over a nonblank cookie.

    ``headers`` is matched case-insensitively and may repeat names. A raw ``Cookie`` header is
    preferred over the parsed ``cookies`` mapping so values are never URL-decoded.
    """
    items = headers.items() if isinstance(headers, Mapping) else headers
    visitor_headers: list[str] = []
    cookie_headers: list[str] = []
    for name, value in items:
        lower = name.lower()
        if lower == VISITOR_HEADER.lower():
            visitor_headers.append(value)
        elif lower == "cookie":
            cookie_headers.append(value)
    for value in visitor_headers:
        visitor_id = normalize_visitor_id(value)
        if visitor_id:
            return visitor_id
    for value in cookie_headers:
        visitor_id = visitor_id_from_cookie_header(value)
        if visitor_id:
            return visitor_id
    return normalize_visitor_id((cookies or {}).get(VISITOR_COOKIE))


@contextmanager
def visitor_from_request(
    headers: Mapping[str, str] | Iterable[tuple[str, str]], cookies: Mapping[str, str] | None = None
) -> Iterator[None]:
    """Extract the visitor from request headers and cookies and scope it for the ``with`` block."""
    with visitor_scope(extract_visitor_id(headers, cookies)):
        yield
