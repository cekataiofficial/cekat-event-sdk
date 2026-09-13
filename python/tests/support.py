from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx

SUCCESS = {
    "success": True,
    "data": {"success": True, "message": "queued", "event_key": "k", "validated_properties": []},
}


def ok(event_key: str = "k") -> httpx.Response:
    envelope = json.loads(json.dumps(SUCCESS))
    envelope["data"]["event_key"] = event_key
    return httpx.Response(200, json=envelope)


def failure(status: int, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(
        status, headers=headers, json={"success": False, "error": f"failed {status}", "code": "c"}
    )


class InterruptedStream(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A response body that fails after sending a prefix."""

    def __init__(self, prefix: bytes) -> None:
        self.prefix = prefix

    def __iter__(self) -> Iterator[bytes]:
        yield self.prefix
        raise httpx.ReadError("connection reset")

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self.prefix
        raise httpx.ReadError("connection reset")


class Chunks(httpx.SyncByteStream, httpx.AsyncByteStream):
    def __init__(self, *chunks: bytes) -> None:
        self.chunks = chunks
        self.consumed = 0

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            self.consumed += 1
            yield chunk

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.consumed += 1
            yield chunk


def recording(sent: list[dict[str, Any]], event_key: str) -> Callable[[httpx.Request], httpx.Response]:
    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(payload(request))
        return ok(event_key)

    return handle


def payload(request: httpx.Request) -> dict[str, Any]:
    decoded: dict[str, Any] = json.loads(request.content)
    return decoded
