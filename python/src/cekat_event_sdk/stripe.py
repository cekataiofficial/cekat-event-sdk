"""Stripe metadata helpers for optional Cekat visitor correlation."""

from __future__ import annotations

from collections.abc import Mapping

from .context import current_visitor_id

_VISITOR_METADATA_KEY = "cekat_visitor_id"


def metadata_for_visitor(visitor_id: object) -> dict[str, str]:
    """Return fresh Stripe metadata for a valid explicit visitor."""
    normalized = _valid_visitor_id(visitor_id)
    return {} if normalized is None else {_VISITOR_METADATA_KEY: normalized}


def metadata_from_current_visitor() -> dict[str, str]:
    """Return fresh Stripe metadata for the current visitor scope."""
    return metadata_for_visitor(current_visitor_id())


def merge_metadata(metadata: Mapping[str, str], visitor_id: object) -> dict[str, str]:
    """Return a metadata copy with a valid Cekat visitor replacing only its key."""
    merged = dict(metadata)
    normalized = _valid_visitor_id(visitor_id)
    if normalized is not None:
        merged[_VISITOR_METADATA_KEY] = normalized
    return merged


def _valid_visitor_id(visitor_id: object) -> str | None:
    if not isinstance(visitor_id, str):
        return None
    normalized = visitor_id.strip()
    if not 1 <= len(normalized) <= 128:
        return None
    for character in normalized:
        if not character.isascii() or (not character.isalnum() and character not in "_-"):
            return None
    return normalized
