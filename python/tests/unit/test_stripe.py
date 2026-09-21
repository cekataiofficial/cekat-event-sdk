from __future__ import annotations

from cekat_event_sdk.context import visitor_scope
from cekat_event_sdk.stripe import merge_metadata, metadata_for_visitor, metadata_from_current_visitor


def test_metadata_for_visitor_validates_boundaries_and_trims() -> None:
    assert metadata_for_visitor(" visitor_A-1 ") == {"cekat_visitor_id": "visitor_A-1"}
    assert metadata_for_visitor("a") == {"cekat_visitor_id": "a"}
    assert metadata_for_visitor("a" * 128) == {"cekat_visitor_id": "a" * 128}
    assert metadata_for_visitor("a" * 129) == {}
    assert metadata_for_visitor("invalid visitor") == {}
    assert metadata_for_visitor(None) == {}


def test_metadata_from_current_visitor_and_merge_are_fresh() -> None:
    with visitor_scope(" scoped "):
        assert metadata_from_current_visitor() == {"cekat_visitor_id": "scoped"}
    assert metadata_from_current_visitor() == {}

    merchant = {"merchant": "keep", "cekat_visitor_id": "replace"}
    merged = merge_metadata(merchant, " visitor_2 ")
    assert merged == {"merchant": "keep", "cekat_visitor_id": "visitor_2"}
    assert merged is not merchant
    assert merchant == {"merchant": "keep", "cekat_visitor_id": "replace"}
    assert merge_metadata(merchant, "invalid visitor") == merchant
    assert merge_metadata(merchant, "invalid visitor") is not merchant
