"""Pure ASGI middleware for Starlette, FastAPI, and any ASGI 3 application.

    app.add_middleware(VisitorMiddleware)   # Starlette / FastAPI
    app = VisitorMiddleware(app)            # any ASGI application

The visitor scope covers the entire downstream call, including streamed responses and background
tasks created inside it. Request and response bodies are never buffered.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from ..context import visitor_from_request

__all__ = ["VisitorMiddleware"]

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class VisitorMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = [
            (bytes(name).decode("latin-1"), bytes(value).decode("latin-1"))
            for name, value in scope.get("headers", ())
        ]
        with visitor_from_request(headers):
            await self.app(scope, receive, send)
