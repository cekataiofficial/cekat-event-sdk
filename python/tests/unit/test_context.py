from __future__ import annotations

import asyncio
import threading

import pytest

from cekat_event_sdk import current_visitor_id, extract_visitor_id, visitor_from_request, visitor_scope
from cekat_event_sdk.context import visitor_id_from_cookie_header


def test_scopes_nest_and_restore_on_exception() -> None:
    assert current_visitor_id() is None
    with visitor_scope(" outer "):
        assert current_visitor_id() == "outer"
        seen: list[str | None] = []

        def fail_inside() -> None:
            with visitor_scope("inner"):
                seen.append(current_visitor_id())
                raise RuntimeError

        with pytest.raises(RuntimeError):
            fail_inside()
        assert seen == ["inner"]
        assert current_visitor_id() == "outer"
        with visitor_scope("   "):
            assert current_visitor_id() is None
    assert current_visitor_id() is None


@pytest.mark.parametrize(
    ("headers", "cookies", "expected"),
    [
        ({"X-Cekat-Visitor-ID": " header ", "Cookie": "_cekat_visitor_id=cookie"}, None, "header"),
        ({"x-cekat-visitor-id": "  ", "cookie": "a=b; _cekat_visitor_id= cookie "}, None, "cookie"),
        ([("X-CEKAT-VISITOR-ID", " "), ("X-Cekat-Visitor-ID", "second")], None, "second"),
        ([("Cookie", "a=1"), ("Cookie", "_cekat_visitor_id=later")], None, "later"),
        ({}, {"_cekat_visitor_id": " parsed "}, "parsed"),
        ({"Cookie": "_cekat_visitor_id=raw%20value"}, {"_cekat_visitor_id": "raw value"}, "raw%20value"),
        ({"Cookie": "other=1"}, {}, None),
        ({}, None, None),
    ],
)
def test_extract_visitor_precedence(
    headers: object, cookies: dict[str, str] | None, expected: str | None
) -> None:
    assert extract_visitor_id(headers, cookies) == expected  # type: ignore[arg-type]


def test_cookie_header_parsing_skips_blank_and_similar_names() -> None:
    assert (
        visitor_id_from_cookie_header("x_cekat_visitor_id=no; _cekat_visitor_id=  ; _cekat_visitor_id=yes")
        == "yes"
    )
    assert visitor_id_from_cookie_header("_cekat_visitor_id") is None
    assert visitor_id_from_cookie_header(None) is None


def test_visitor_from_request_scopes_the_block() -> None:
    with visitor_from_request({"X-Cekat-Visitor-ID": "abc"}):
        assert current_visitor_id() == "abc"
    assert current_visitor_id() is None


@pytest.mark.asyncio
async def test_concurrent_tasks_are_isolated() -> None:
    async def observe(visitor: str) -> str | None:
        with visitor_scope(visitor):
            await asyncio.sleep(0.01)
            child = asyncio.create_task(asyncio.sleep(0, result=current_visitor_id()))
            return await child

    assert list(await asyncio.gather(observe("a"), observe("b"))) == ["a", "b"]
    assert current_visitor_id() is None


@pytest.mark.asyncio
async def test_cancellation_restores_scope() -> None:
    entered = asyncio.Event()

    async def blocked() -> None:
        with visitor_scope("cancelled"):
            entered.set()
            await asyncio.sleep(60)

    with visitor_scope("outer"):
        task = asyncio.create_task(blocked())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert current_visitor_id() == "outer"


def test_threads_do_not_share_scope() -> None:
    seen: list[str | None] = []
    with visitor_scope("main"):
        thread = threading.Thread(target=lambda: seen.append(current_visitor_id()))
        thread.start()
        thread.join()
    assert seen == [None]
