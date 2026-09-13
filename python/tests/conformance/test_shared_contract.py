"""Executes every shared fixture against the mock ingest server.

Driven only by the four CEKAT_CONFORMANCE_* variables that ``scripts/conformance`` validates.
Every discovered case runs exactly once and prints one JSON result line.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, nullcontext
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from cekat_event_sdk import (
    Acknowledgement,
    ApiError,
    AsyncClient,
    AuthenticationError,
    CekatError,
    Client,
    Event,
    EventDefinitionNotFoundError,
    ResponseDecodeError,
    TransportError,
    ValidationError,
    visitor_from_request,
    visitor_scope,
)
from cekat_event_sdk.integrations.asgi import VisitorMiddleware
from cekat_event_sdk.protocol import ReceivedResponse

REQUIRED_ENV = (
    "CEKAT_CONFORMANCE_BASE_URL",
    "CEKAT_CONFORMANCE_CONTROL_URL",
    "CEKAT_CONFORMANCE_ACCESS_TOKEN",
    "CEKAT_CONFORMANCE_FIXTURES",
)
EVENT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
OCCURRED_AT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
USER_AGENT = re.compile(r"cekat-event-sdk-python/\d+\.\d+\.\d+\S*( .+)?")
ERROR_TYPES: dict[str, type[CekatError]] = {
    "validation_error": ValidationError,
    "authentication_error": AuthenticationError,
    "event_definition_not_found_error": EventDefinitionNotFoundError,
    "api_error": ApiError,
    "transport_error": TransportError,
    "response_decode_error": ResponseDecodeError,
}


def _environment() -> dict[str, str]:
    values = {name: os.environ.get(name, "") for name in REQUIRED_ENV}
    missing = [name for name, value in values.items() if not value]
    if missing:
        pytest.fail(f"missing {', '.join(missing)}; run scripts/conformance", pytrace=False)
    extra = sorted(
        set(name for name in os.environ if name.startswith("CEKAT_CONFORMANCE_")) - set(REQUIRED_ENV)
    )
    if extra:
        pytest.fail(f"unrecognized conformance environment variables: {', '.join(extra)}", pytrace=False)
    fixtures = Path(values["CEKAT_CONFORMANCE_FIXTURES"])
    if not fixtures.is_absolute() or not fixtures.is_dir():
        pytest.fail("CEKAT_CONFORMANCE_FIXTURES must be an absolute directory", pytrace=False)
    return values


def _schemas(directory: Path) -> dict[str, Draft202012Validator]:
    resources = []
    for path in sorted(directory.glob("*.schema.json")):
        document = json.loads(path.read_text())
        resources.append((document["$id"], Resource.from_contents(document)))
    registry: Registry[Any] = Registry().with_resources(resources)
    validators = {}
    for name in ("conformance-case", "request-journal"):
        document = json.loads((directory / f"{name}.schema.json").read_text())
        Draft202012Validator.check_schema(document)
        validators[name] = Draft202012Validator(document, registry=registry)
    return validators


class Recorder:
    """Wraps the SDK attempt to observe response byte accounting and backoff delays."""

    def __init__(self) -> None:
        self.last: ReceivedResponse | None = None
        self.sleeps: list[float] = []


def _midpoint(low: float, high: float) -> float:
    return (low + high) / 2


class Case:
    def __init__(
        self, fixture: dict[str, Any], env: dict[str, str], schemas: dict[str, Draft202012Validator]
    ) -> None:
        self.fixture = fixture
        self.id: str = fixture["id"]
        self.expect: dict[str, Any] = fixture["expect"]
        self.env = env
        self.schemas = schemas
        self.control = httpx.Client(base_url=env["CEKAT_CONFORMANCE_CONTROL_URL"], timeout=10)
        self.recorder = Recorder()
        self.expanded: bytes | None = None

    # -- mock controls -------------------------------------------------------------------------

    def queue(self) -> None:
        assert self.control.post("/__control/reset").status_code == 204
        responses = [dict(response) for response in self.fixture.get("responses", [])]
        recipe = self.fixture.get("response_body_recipe")
        if recipe is not None:
            assert len(responses) == 1
            body = ""
            while len(body.encode()) < recipe["minimum_utf8_bytes"]:
                body += recipe["unit"]
            body += recipe["suffix"]
            responses[0]["body"] = body
            self.expanded = body.encode()
        queued = self.control.post("/__control/responses", json={"responses": responses})
        assert queued.status_code == 204, queued.text

    def journal(self) -> list[dict[str, Any]]:
        response = self.control.get("/__control/requests")
        assert response.status_code == 200
        payload = response.json()
        errors = [error.message for error in self.schemas["request-journal"].iter_errors(payload)]
        assert not errors, f"{self.id}: journal schema {errors[:3]}"
        requests: list[dict[str, Any]] = payload["requests"]
        return requests

    # -- dispatch ------------------------------------------------------------------------------

    def event(self) -> Event:
        operation = self.fixture["operation"]
        source = operation["event"]
        properties = (
            _recipe(operation["properties_recipe"])
            if "properties_recipe" in operation
            else source.get("properties")
        )
        occurred_at = source.get("occurred_at")
        return Event(
            email=source.get("email"),
            phone_number=source.get("phone_number"),
            contact_name=source.get("contact_name"),
            visitor_id=source.get("visitor_id"),
            properties=properties,
            event_id=source.get("event_id"),
            occurred_at=datetime.fromisoformat(occurred_at.replace("Z", "+00:00")) if occurred_at else None,
        )

    def scope(self) -> AbstractContextManager[None]:
        inbound = self.fixture.get("inbound", {})
        if "header_visitor_id" in inbound or "cookie_visitor_id" in inbound:
            headers = []
            if "header_visitor_id" in inbound:
                headers.append(("X-Cekat-Visitor-ID", inbound["header_visitor_id"]))
            if "cookie_visitor_id" in inbound:
                headers.append(("Cookie", f"_cekat_visitor_id={inbound['cookie_visitor_id']}"))
            return visitor_from_request(headers)
        if "ambient_visitor_id" in inbound:
            return visitor_scope(inbound["ambient_visitor_id"])
        return nullcontext()

    def client_options(self) -> dict[str, Any]:
        options = self.fixture.get("client", {})
        return {
            "access_token": self.env["CEKAT_CONFORMANCE_ACCESS_TOKEN"],
            "base_url": self.env["CEKAT_CONFORMANCE_BASE_URL"],
            "timeout": options["timeout_ms"] / 1000 if "timeout_ms" in options else 3.0,
            "retry_count": options.get("retry_count", 2),
            "_uniform": _midpoint,
        }

    def call(self, client: Any) -> Any:
        operation = self.fixture["operation"]
        event = self.event()
        name = operation["name"]
        if name == "custom_event":
            return client.custom_event(operation["event_key"], event)
        if name == "order_paid":
            return client.order_paid(operation["amount"], operation["currency"], event)
        if name in ("user_registration", "user_login", "order_created"):
            return getattr(client, name)(event)
        raise AssertionError(f"{self.id}: unknown operation {name}")

    def run_sync(self) -> tuple[Acknowledgement | None, CekatError | None]:
        recorder = self.recorder
        options = self.client_options()
        with Client(**options, _sleep=lambda seconds: recorder.sleeps.append(seconds)) as client:
            _record_attempts(client, recorder)
            try:
                inbound = self.fixture.get("inbound", {})
                if "header_visitor_id" in inbound or "cookie_visitor_id" in inbound:
                    return self.through_asgi(client), None
                with self.scope():
                    return self.call(client), None
            except CekatError as error:
                return None, error

    async def run_async(self) -> tuple[Acknowledgement | None, CekatError | None]:
        recorder = self.recorder

        async def sleep(seconds: float) -> None:
            recorder.sleeps.append(seconds)

        async with AsyncClient(**self.client_options(), _sleep=sleep) as client:
            _record_async_attempts(client, recorder)
            try:
                with self.scope():
                    return await self.call(client), None
            except CekatError as error:
                return None, error

    def through_asgi(self, client: Client) -> Acknowledgement:
        """Exercise the ASGI middleware with the fixture's raw inbound header and cookie."""
        inbound = self.fixture["inbound"]
        headers = []
        if "header_visitor_id" in inbound:
            headers.append((b"x-cekat-visitor-id", inbound["header_visitor_id"].encode("latin-1")))
        if "cookie_visitor_id" in inbound:
            headers.append((b"cookie", f"_cekat_visitor_id={inbound['cookie_visitor_id']}".encode("latin-1")))
        outcome: list[Acknowledgement] = []

        async def app(scope: Any, receive: Any, send: Any) -> None:
            outcome.append(self.call(client))

        async def nothing() -> Any:
            return {}

        async def discard(message: Any) -> None:
            return None

        scope = {"type": "http", "method": "POST", "path": "/", "headers": headers}
        asyncio.run(VisitorMiddleware(app)(scope, nothing, discard))
        return outcome[0]

    async def run_cancellation(self) -> None:
        phase = self.fixture["cancellation"]["phase"]
        recorder = self.recorder
        sleeping = asyncio.Event()

        async def sleep(seconds: float) -> None:
            recorder.sleeps.append(seconds)
            sleeping.set()
            await asyncio.sleep(60)

        async with AsyncClient(**self.client_options(), _sleep=sleep) as client:
            _record_async_attempts(client, recorder)
            with self.scope():
                task = asyncio.ensure_future(self.call(client))
            if phase == "before_request":
                task.cancel()
            elif phase == "during_request":
                deadline = time.monotonic() + 2
                while not await asyncio.to_thread(self.journal) and time.monotonic() < deadline:
                    await asyncio.sleep(0.002)
                task.cancel()
            elif phase == "during_backoff":
                await asyncio.wait_for(sleeping.wait(), 5)
                task.cancel()
            else:
                raise AssertionError(f"{self.id}: unknown cancellation phase {phase}")
            with pytest.raises(asyncio.CancelledError):
                await task

    # -- assertions ----------------------------------------------------------------------------

    def execute(self) -> None:
        """Run the fixture once per client flavor; cancellation exists only for ``AsyncClient``."""
        if "cancellation" in self.fixture:
            assert self.expect["result"] == "caller_cancelled"
            self.execute_with(
                lambda: (asyncio.run(self.run_cancellation()), (None, None))[1], check_result=False
            )
            return
        self.execute_with(self.run_sync)
        self.execute_with(lambda: asyncio.run(self.run_async()))

    def execute_with(
        self, run: Callable[[], tuple[Acknowledgement | None, CekatError | None]], check_result: bool = True
    ) -> None:
        self.recorder = Recorder()
        self.queue()
        started = datetime.now(timezone.utc)
        result, error = run()
        finished = datetime.now(timezone.utc)
        if check_result:
            self.assert_result(result, error)
        self.assert_delays()
        self.assert_journal(started, finished)

    def assert_result(self, result: Acknowledgement | None, error: CekatError | None) -> None:
        expect = self.expect
        token = self.env["CEKAT_CONFORMANCE_ACCESS_TOKEN"]
        if error is not None:
            for text in (str(error), repr(error), repr(error.__cause__), str(error.__cause__)):
                assert token not in text, f"{self.id}: token leaked"
        if expect["result"] == "acknowledgement":
            assert error is None, f"{self.id}: {type(error).__name__} {error}"
            assert isinstance(result, Acknowledgement)
            if "acknowledgement" in expect:
                ack = expect["acknowledgement"]
                assert (
                    result.success,
                    result.message,
                    result.event_key,
                    list(result.validated_properties),
                ) == (
                    ack["success"],
                    ack["message"],
                    ack["event_key"],
                    ack["validated_properties"],
                ), self.id
        else:
            expected_type = ERROR_TYPES[expect["result"]]
            assert type(error) is expected_type, (
                f"{self.id}: expected {expected_type.__name__}, got {error!r}"
            )
            assert error is not None
            if not isinstance(error, ValidationError):
                assert error.attempts == expect["attempts"], self.id
                assert error.delivery_outcome_unknown is expect.get(
                    "delivery_outcome_unknown", isinstance(error, TransportError)
                ), self.id
            if "status" in expect:
                assert getattr(error, "status_code", None) == expect["status"], self.id
            if "error_message" in expect:
                assert error.message == expect["error_message"], self.id
            if "server_error" in expect:
                assert error.message == expect["server_error"], self.id
            if "server_code" in expect:
                assert getattr(error, "code", None) == expect["server_code"], self.id
            if "retained_body_bytes" in expect:
                raw_body: bytes = getattr(error, "raw_body")  # noqa: B009
                assert len(raw_body) == expect["retained_body_bytes"], self.id
                if self.expanded is not None:
                    assert raw_body == self.expanded[: expect["retained_body_bytes"]], self.id
        if "observed_body_bytes" in expect or "body_truncated" in expect:
            last = self.recorder.last
            assert last is not None
            assert last.observed_body_bytes == expect["observed_body_bytes"], self.id
            assert last.body_truncated is expect["body_truncated"], self.id

    def assert_delays(self) -> None:
        sleeps = [round(seconds * 1000) for seconds in self.recorder.sleeps]
        if "jitter_bounds_ms" in self.expect:
            bounds = self.expect["jitter_bounds_ms"]
            assert len(sleeps) == len(bounds), f"{self.id}: sleeps {sleeps}"
            for delay, (low, high) in zip(sleeps, bounds, strict=True):
                assert low <= delay <= high, f"{self.id}: delay {delay} outside [{low}, {high}]"
        if "minimum_retry_delays_ms" in self.expect:
            minimums = self.expect["minimum_retry_delays_ms"]
            assert len(sleeps) == len(minimums), f"{self.id}: sleeps {sleeps}"
            for delay, minimum in zip(sleeps, minimums, strict=True):
                assert delay >= minimum, f"{self.id}: delay {delay} below {minimum}"

    def assert_journal(self, started: datetime, finished: datetime) -> None:
        requests = self.journal()
        assert len(requests) == self.expect["attempts"], f"{self.id}: {len(requests)} requests"
        expected_request = self.expect.get("request")
        generated: dict[str, str] = {}
        for index, entry in enumerate(requests):
            agents = entry["headers"].get("user-agent", [])
            assert len(agents) == 1, f"{self.id}: user-agent {agents}"
            assert USER_AGENT.fullmatch(agents[0]), f"{self.id}: user-agent {agents}"
            if expected_request is None:
                continue
            assert (entry["sequence"], entry["method"], entry["path"]) == (
                index + 1,
                "POST",
                expected_request["path"],
            )
            assert entry["headers"].get("authorization") == [expected_request["authorization"]], self.id
            assert entry["headers"].get("content-type") == ["application/json"], self.id
            actual = json.loads(entry["body"])
            for field in ("event_id", "occurred_at"):
                if field in expected_request["payload"]:
                    continue
                value = actual.pop(field)
                assert isinstance(value, str), f"{self.id}: {field}"
                if field == "event_id":
                    assert EVENT_ID.fullmatch(value), f"{self.id}: event_id {value}"
                else:
                    assert OCCURRED_AT.fullmatch(value), f"{self.id}: occurred_at {value}"
                    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    assert started - timedelta(seconds=1) <= moment <= finished + timedelta(seconds=1), (
                        self.id
                    )
                assert generated.setdefault(field, value) == value, f"{self.id}: {field} not reused"
            assert _canonical(actual) == _canonical(expected_request["payload"]), (
                f"{self.id}: payload {actual}"
            )


def _record_attempts(client: Client, recorder: Recorder) -> None:
    attempt = client._attempt

    def recorded(body: bytes) -> ReceivedResponse:
        recorder.last = attempt(body)
        return recorder.last

    client._attempt = recorded  # type: ignore[method-assign]


def _record_async_attempts(client: AsyncClient, recorder: Recorder) -> None:
    attempt = client._attempt

    async def recorded(body: bytes) -> ReceivedResponse:
        recorder.last = await attempt(body)
        return recorder.last

    client._attempt = recorded  # type: ignore[method-assign]


def _recipe(name: str) -> dict[Any, Any]:
    if name == "cycle":
        value: dict[str, Any] = {}
        value["self"] = value
        return value
    recipes: dict[str, Callable[[], object]] = {
        "nan": lambda: math.nan,
        "positive_infinity": lambda: math.inf,
        "negative_infinity": lambda: -math.inf,
        "unsafe_integer_high": lambda: 9_007_199_254_740_992,
        "unsafe_integer_low": lambda: -9_007_199_254_740_992,
        "non_string_key": lambda: {1: "one"},
        "runtime_object": object,
    }
    if name not in recipes:
        raise AssertionError(f"unknown properties recipe {name}")
    return {"value": recipes[name]()}


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    return Decimal(str(value))


def _fixtures(directory: Path, schema: Draft202012Validator) -> Iterator[dict[str, Any]]:
    files = sorted(path for path in directory.iterdir() if path.suffix == ".json" and path.is_file())
    if not files:
        raise AssertionError("fixture corpus contains no direct JSON files")
    seen: set[str] = set()
    for path in files:
        fixture = json.loads(path.read_text())
        errors = [error.message for error in schema.iter_errors(fixture)]
        if errors:
            raise AssertionError(f"{path.name} violates the shared schema: {errors[:3]}")
        if fixture["id"] != path.stem:
            raise AssertionError(f"{path.name}: filename/ID mismatch")
        if fixture["id"] in seen:
            raise AssertionError(f"duplicate fixture ID {fixture['id']}")
        seen.add(fixture["id"])
        yield fixture


def test_schemas_reject_malformed_fixtures() -> None:
    directory = Path(__file__).parents[3] / "conformance" / "fixtures"
    schema = _schemas(directory / "schemas")["conformance-case"]
    fixture = json.loads((directory / "cases" / "retry-500-500-success.json").read_text())
    assert schema.is_valid(fixture)
    mutations: list[Callable[[dict[str, Any]], None]] = [
        lambda value: value["responses"][0].__setitem__("headers", 1),
        lambda value: value["expect"].__setitem__("status", "400"),
        lambda value: value["expect"]["request"].__setitem__("extra", True),
        lambda value: value["operation"].pop("currency"),
        lambda value: value["expect"].__setitem__("jitter_bounds_ms", [[0, 101], [0, 200]]),
    ]
    for mutate in mutations:
        invalid = json.loads(json.dumps(fixture))
        mutate(invalid)
        assert not schema.is_valid(invalid)


def test_every_discovered_fixture_executes_exactly_once() -> None:
    env = _environment()
    directory = Path(env["CEKAT_CONFORMANCE_FIXTURES"])
    schemas = _schemas(directory.parent / "schemas")
    discovered: list[str] = []
    passed: list[str] = []
    for fixture in _fixtures(directory, schemas["conformance-case"]):
        discovered.append(fixture["id"])
        case = Case(fixture, env, schemas)
        try:
            case.execute()
        finally:
            case.control.close()
        passed.append(fixture["id"])
        sys.stdout.write(json.dumps({"id": fixture["id"], "status": "passed"}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    assert sorted(passed) == sorted(discovered)
