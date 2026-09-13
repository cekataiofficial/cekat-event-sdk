"""Django middleware that scopes the inbound visitor ID for the request.

Add ``"cekat_event_sdk.integrations.django.DjangoVisitorMiddleware"`` to ``MIDDLEWARE``. It supports
both WSGI and ASGI deployments without thread-local state.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from asgiref.sync import iscoroutinefunction, markcoroutinefunction

from ..context import visitor_from_request

__all__ = ["DjangoVisitorMiddleware"]


class DjangoVisitorMiddleware:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response
        self._is_async = iscoroutinefunction(get_response)
        if self._is_async:
            markcoroutinefunction(self)

    def __call__(self, request: Any) -> Any:
        if self._is_async:
            return self.__acall__(request)
        with visitor_from_request(request.headers, request.COOKIES):
            return self.get_response(request)

    async def __acall__(self, request: Any) -> Any:
        with visitor_from_request(request.headers, request.COOKIES):
            response: Awaitable[Any] = self.get_response(request)
            return await response
