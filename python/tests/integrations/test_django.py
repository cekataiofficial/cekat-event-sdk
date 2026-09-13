from __future__ import annotations

import asyncio
import json
from typing import Any

import django
import httpx
import pytest
from django.conf import settings

if not settings.configured:
    settings.configure(
        DEBUG=False,
        SECRET_KEY="test-only",
        ALLOWED_HOSTS=["testserver"],
        ROOT_URLCONF=__name__,
        MIDDLEWARE=["cekat_event_sdk.integrations.django.DjangoVisitorMiddleware"],
        USE_TZ=True,
    )
    django.setup()

from asgiref.sync import iscoroutinefunction
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.test import AsyncClient as DjangoAsyncClient
from django.test import AsyncRequestFactory, RequestFactory
from django.test import Client as DjangoClient
from django.urls import path

from cekat_event_sdk import Client, Event, current_visitor_id, visitor_scope
from cekat_event_sdk.integrations.django import DjangoVisitorMiddleware
from tests.support import recording

sent: list[dict[str, Any]] = []
sdk = Client(
    "token",
    base_url="https://example.test",
    http_client=httpx.Client(transport=httpx.MockTransport(recording(sent, "order_paid"))),
)


def checkout(request: HttpRequest) -> JsonResponse:
    order = json.loads(request.body)
    ack = sdk.order_paid(
        order["amount"], order["currency"], Event(email=order["email"], properties={"order_id": order["id"]})
    )
    return JsonResponse({"visitor": current_visitor_id(), "event_key": ack.event_key})


async def async_visitor(request: HttpRequest) -> HttpResponse:
    await asyncio.sleep(0.01)
    return HttpResponse(current_visitor_id() or "none")


urlpatterns = [path("checkout", checkout), path("async-visitor", async_visitor)]


def test_post_view_tracks_with_request_visitor() -> None:
    sent.clear()
    client = DjangoClient()
    client.cookies["_cekat_visitor_id"] = "cookie"
    response = client.post(
        "/checkout",
        data=json.dumps({"id": "ord-1", "amount": 99.5, "currency": "IDR", "email": "buyer@example.test"}),
        content_type="application/json",
        headers={"X-Cekat-Visitor-ID": " header "},
    )
    assert response.status_code == 200
    assert response.json() == {"visitor": "header", "event_key": "order_paid"}
    assert sent[0]["visitor_id"] == "header"
    assert sent[0]["properties"] == {"order_id": "ord-1", "amount": 99.5, "currency": "IDR"}
    assert current_visitor_id() is None


@pytest.mark.asyncio
async def test_async_stack_isolates_concurrent_requests() -> None:
    cookie_client = DjangoAsyncClient()
    cookie_client.cookies["_cekat_visitor_id"] = "b"
    responses = await asyncio.gather(
        DjangoAsyncClient().get("/async-visitor", headers={"X-Cekat-Visitor-ID": "a"}),
        cookie_client.get("/async-visitor"),
        DjangoAsyncClient().get("/async-visitor"),
    )
    assert [response.content for response in responses] == [b"a", b"b", b"none"]


def test_sync_middleware_restores_outer_scope_on_exception() -> None:
    def failing(request: HttpRequest) -> HttpResponse:
        assert current_visitor_id() == "cookie"
        raise RuntimeError("boom")

    middleware = DjangoVisitorMiddleware(failing)
    assert not iscoroutinefunction(middleware)
    request = RequestFactory().get(
        "/", HTTP_X_CEKAT_VISITOR_ID="  ", HTTP_COOKIE="_cekat_visitor_id= cookie "
    )
    with visitor_scope("outer"):
        with pytest.raises(RuntimeError):
            middleware(request)
        assert current_visitor_id() == "outer"


@pytest.mark.asyncio
async def test_async_middleware_is_marked_and_cleans_up() -> None:
    async def failing(request: HttpRequest) -> HttpResponse:
        assert current_visitor_id() == "header"
        raise RuntimeError("boom")

    middleware = DjangoVisitorMiddleware(failing)
    assert iscoroutinefunction(middleware)
    request = AsyncRequestFactory().get("/", headers={"X-Cekat-Visitor-ID": "header"})
    with pytest.raises(RuntimeError):
        await middleware(request)
    assert current_visitor_id() is None
