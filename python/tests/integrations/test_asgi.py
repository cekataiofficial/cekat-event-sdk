from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route

from cekat_event_sdk import AsyncClient, Event, current_visitor_id, visitor_scope
from cekat_event_sdk.integrations.asgi import VisitorMiddleware
from tests.support import ok, payload


async def run_asgi(app: Any, headers: list[tuple[bytes, bytes]]) -> bytes:
    body = b""

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Any) -> None:
        nonlocal body
        if message["type"] == "http.response.body":
            body += message.get("body", b"")

    await app({"type": "http", "method": "GET", "path": "/", "headers": headers}, receive, send)
    return body


async def echo(scope: Any, receive: Any, send: Any) -> None:
    await asyncio.sleep(0.01)
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": (current_visitor_id() or "none").encode()})


@pytest.mark.asyncio
async def test_raw_asgi_precedence_and_concurrent_isolation() -> None:
    wrapped = VisitorMiddleware(echo)
    results = await asyncio.gather(
        run_asgi(wrapped, [(b"x-cekat-visitor-id", b" a ")]),
        run_asgi(
            wrapped,
            [
                (b"x-cekat-visitor-id", b"  "),
                (b"x-cekat-visitor-id", b"b"),
                (b"cookie", b"_cekat_visitor_id=c"),
            ],
        ),
        run_asgi(wrapped, [(b"cookie", b"x=1"), (b"cookie", b"_cekat_visitor_id= c ")]),
        run_asgi(wrapped, []),
    )
    assert list(results) == [b"a", b"b", b"c", b"none"]
    assert current_visitor_id() is None


@pytest.mark.asyncio
async def test_non_http_scopes_pass_through_and_exceptions_restore() -> None:
    seen: list[str | None] = []

    async def lifespan(scope: Any, receive: Any, send: Any) -> None:
        seen.append(current_visitor_id())

    async def failing(scope: Any, receive: Any, send: Any) -> None:
        raise RuntimeError("boom")

    with visitor_scope("outer"):
        await VisitorMiddleware(lifespan)({"type": "lifespan"}, None, None)  # type: ignore[arg-type]
        with pytest.raises(RuntimeError):
            await run_asgi(VisitorMiddleware(failing), [(b"x-cekat-visitor-id", b"inner")])
        assert current_visitor_id() == "outer"
    assert seen == ["outer"]


@pytest.mark.asyncio
async def test_cancellation_propagates_and_restores() -> None:
    entered = asyncio.Event()

    async def blocked(scope: Any, receive: Any, send: Any) -> None:
        entered.set()
        await asyncio.sleep(60)

    task = asyncio.create_task(run_asgi(VisitorMiddleware(blocked), [(b"x-cekat-visitor-id", b"v")]))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert current_visitor_id() is None


def sdk(sent: list[dict[str, Any]]) -> AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        sent.append(payload(request))
        return ok("order_paid")

    return AsyncClient(
        "token",
        base_url="https://example.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


@pytest.mark.asyncio
async def test_starlette_streaming_and_sdk_call() -> None:
    sent: list[dict[str, Any]] = []
    client = sdk(sent)

    async def checkout(request: Request) -> PlainTextResponse:
        order = await request.json()
        await asyncio.sleep(0)
        await client.order_paid(order["amount"], order["currency"], Event(email=order["email"]))
        return PlainTextResponse(current_visitor_id() or "none")

    async def stream(request: Request) -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            for _ in range(2):
                await asyncio.sleep(0)
                yield (current_visitor_id() or "none").encode()

        return StreamingResponse(chunks())

    app = Starlette(routes=[Route("/checkout", checkout, methods=["POST"]), Route("/stream", stream)])
    app.add_middleware(VisitorMiddleware)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as http:
        response = await http.post(
            "/checkout",
            json={"amount": 5, "currency": "IDR", "email": "a@example.test"},
            headers={"Cookie": "_cekat_visitor_id=cv"},
        )
        streamed = await http.get("/stream", headers={"X-Cekat-Visitor-ID": "sv"})
    assert response.text == "cv"
    assert sent[0]["visitor_id"] == "cv"
    assert sent[0]["properties"] == {"amount": 5, "currency": "IDR"}
    assert streamed.text == "svsv"


@pytest.mark.asyncio
async def test_fastapi_dependency_free_usage() -> None:
    sent: list[dict[str, Any]] = []
    client = sdk(sent)
    app = FastAPI()
    app.add_middleware(VisitorMiddleware)

    @app.post("/paid")
    async def paid(order: dict[str, Any]) -> dict[str, Any]:
        ack = await client.order_paid(order["amount"], "USD", Event(email=order["email"]))
        return {"event_key": ack.event_key, "visitor": current_visitor_id()}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as http:
        results = await asyncio.gather(
            *(
                http.post(
                    "/paid",
                    json={"amount": i, "email": "a@example.test"},
                    headers={"X-Cekat-Visitor-ID": f"v{i}"},
                )
                for i in range(5)
            )
        )
    assert [result.json()["visitor"] for result in results] == [f"v{i}" for i in range(5)]
    assert sorted(item["visitor_id"] for item in sent) == [f"v{i}" for i in range(5)]


@pytest.mark.asyncio
async def test_fastapi_background_tasks_and_created_tasks_see_the_visitor() -> None:

    sent: list[dict[str, Any]] = []
    client = sdk(sent)
    app = FastAPI()
    app.add_middleware(VisitorMiddleware)
    tasks: set[asyncio.Task[Any]] = set()

    @app.post("/login")
    async def login(background: BackgroundTasks) -> dict[str, bool]:
        background.add_task(client.user_login, Event(email="background@example.test"))
        task = asyncio.create_task(client.user_login(Event(email="task@example.test")))
        tasks.add(task)
        return {"ok": True}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as http:
        response = await http.post("/login", headers={"X-Cekat-Visitor-ID": "bg"})
    await asyncio.gather(*tasks)
    assert response.json() == {"ok": True}
    assert sorted((item["email"], item["visitor_id"]) for item in sent) == [
        ("background@example.test", "bg"),
        ("task@example.test", "bg"),
    ]
