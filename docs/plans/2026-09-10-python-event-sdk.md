# Python Event SDK Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).

> **Implementation notes (2026-09-13) — as built, overriding the tasks below.** Framework extras follow current support: `Django>=5.2,<7` (4.2 is end of life; 6.x requires Python 3.12+), `Flask>=3.1,<4`, `starlette>=0.41,<2`, `fastapi>=0.115.3,<1`; test tooling allows pytest 9, pytest-asyncio 1.x, mypy 2.x, and twine 7. `anyio>=4.5,<5` is a declared runtime dependency (already required by httpx): `AsyncClient` uses `anyio.move_on_after` for a per-attempt deadline covering headers and body and `anyio.sleep` for backoff, so it also runs under Trio; the sync client uses httpx per-operation timeouts plus a body deadline check. `Event` adds `event_id`/`occurred_at` (timezone-aware `datetime`); `order_paid(amount, currency, event)`. `retry.py` holds retry decisions and `Retry-After` parsing; `protocol.py` holds bounded capture and decoding, with a fixed status-text table (Python's `HTTPStatus` phrases differ by version). `ResponseDecodeError` always has `status_code=200`; `CekatError` exposes `attempts` and `delivery_outcome_unknown` on every subclass. Properties accept `Decimal` (sent as a number), tuples, and `str`-subclass enums. `extract_visitor_id` reads the raw `Cookie` header before a parsed cookie mapping, so values are never unquoted or URL-decoded; the ASGI middleware passes raw headers. Declared floors are proven with `constraints-lowest.txt` instead of a lowest resolver. The conformance runner executes every non-cancellation fixture through both `Client` and `AsyncClient` (one result line per fixture) and cancellation fixtures through `AsyncClient`; `pytest` without arguments excludes the conformance module. `scripts/package` is a Python script run with the development interpreter; it adds `pip-audit`, `twine check --strict`, and wheel-content checks. Evidence and the tested matrix are in `python/docs/compatibility.md`.



> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independently releasable `cekat-event-sdk` Python package with synchronous and asynchronous HTTPX clients, isolated visitor context, Django/Flask/pure-ASGI adapters, shared conformance coverage, and reproducible no-publish packaging.

**Architecture:** Keep protocol models, validation, response decoding, retry policy, and visitor context in a framework-neutral typed core. `Client` owns or accepts an `httpx.Client`; `AsyncClient` owns or accepts an `httpx.AsyncClient`; both call the same pure protocol functions while retaining separate sync/async retry loops. Framework adapters only extract the fixed header/cookie, establish a `ContextVar` scope with a reset token, invoke the application, and restore state in `finally`.

**Tech Stack:** CPython, PEP 621/Hatchling, HTTPX, pytest, pytest-asyncio, Ruff, mypy, Django, Flask, Starlette/FastAPI test clients, `build`, and Twine.

**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`

## Global Constraints

- Package/distribution name: `cekat-event-sdk`; import package: `cekat_event_sdk`; initial package-preparation version: `0.1.0`.
- Before dependency setup, query official Python lifecycle and package metadata, record the observed evidence, and stop if the proposed Python `>=3.10` floor cannot satisfy the maintained/current and roughly-five-year policy. Repeat the gate immediately before release preparation.
- Endpoint: `POST <origin>/api/events/ingest`; default origin `https://server.cekat.ai`; only an absolute HTTP(S) origin with no credentials, non-root path, query, or fragment is valid. Normalize one trailing slash.
- Send `Authorization: Bearer <access_token>` and `Content-Type: application/json`; never send `business_id`; never expose the token in errors, diagnostics, or representations.
- Constructor requires a nonblank access token. Defaults are a 10-second timeout per network attempt and two retries after the initial attempt. Caller/task lifetime bounds the entire async operation.
- Retry only HTTPX transport failures, HTTPX timeouts while the operation remains active, and HTTP `500`. Never retry `400`, `401`, `404`, other HTTP statuses, or `asyncio.CancelledError`.
- Full-jitter upper bounds are `0.1 * 2 ** (retry_number - 1)` seconds capped at `1.0` second; the default delays are therefore uniform `[0, 0.1]` and `[0, 0.2]`. Async cancellation interrupts requests and `asyncio.sleep` and propagates unchanged.
- Retain at most the first 65,536 response bytes. Decode diagnostic text as UTF-8 with replacement. A received HTTP response always has `delivery_outcome_unknown=False`; transport failures/timeouts have it `True`.
- A valid HTTP `200` is exactly a top-level object with `success is True` and a `data` object whose `success is True`, `message` and `event_key` are non-empty strings, and `validated_properties` is a list containing only strings. Ignore additional fields. Invalid `200` is `ResponseDecodeError`.
- The error envelope is `{"success":false,"error":"non-empty text","code":"optional string"}`. A malformed non-200 body remains status-classified with bounded raw bytes and the HTTP reason phrase; it is not `ResponseDecodeError`.
- Validate nonblank `event_key` and at least one nonblank `email`/`phone_number`; trim only to test identity emptiness and preserve submitted identity/contact strings.
- Properties recursively accept only `None`, booleans, strings, finite numbers, integers in `[-9007199254740991, 9007199254740991]`, lists, and string-keyed plain dictionaries. Reject cycles and Python-specific values before any network attempt without echoing values.
- Visitor header is `X-Cekat-Visitor-ID`; cookie is `_cekat_visitor_id`; header wins over cookie. Visitor IDs are trimmed for storage/transmission. Blank explicit visitor IDs are absent and fall back to ambient context; a nonblank explicit visitor ID wins.
- Common methods use fixed keys `user_registration`, `user_login`, `order_created`, `order_paid` and `is_common=True`; `custom_event` uses `is_common=False`. No method promises idempotency, durable storage, delivery status, identity-resolution completion, or special common-event server semantics.
- Injected HTTPX clients are never closed by the SDK. SDK-created clients support context managers and are closed by `close()`/`aclose()`.
- Every test is written red first. Run commands below from `python/` unless a command explicitly begins with `cd`.

---

## File Map

```text
python/
├── pyproject.toml                         # PEP 621 metadata, dependency ranges, extras, test/tool config
├── README.md                              # Python API, lifecycle, middleware, retry/cancellation caveats
├── docs/
│   ├── compatibility.md                   # support policy and verification procedure
│   └── compatibility-evidence.json        # generated official runtime/package observations
├── scripts/
│   ├── verify-compatibility               # execution/release metadata gate
│   ├── conformance                        # stable root-runner entrypoint
│   └── package                            # test/build/check/hash no-publish entrypoint
├── src/cekat_event_sdk/
│   ├── __init__.py                        # supported public exports
│   ├── py.typed                           # PEP 561 marker
│   ├── models.py                          # Event and Acknowledgement immutable values
│   ├── errors.py                          # six public typed error categories
│   ├── context.py                         # ContextVar, extraction, scoped reset APIs
│   ├── validation.py                      # config/event/properties validation and payload construction
│   ├── protocol.py                        # bounded response capture and envelope/status decoding
│   ├── retry.py                           # pure retry decision and jitter bound helpers
│   ├── client.py                          # synchronous HTTPX client and wrappers
│   ├── async_client.py                    # asynchronous HTTPX client and wrappers
│   └── integrations/
│       ├── __init__.py                    # integration namespace
│       ├── django.py                      # sync/async-capable Django middleware
│       ├── flask.py                       # Flask extension hooks
│       └── asgi.py                        # framework-independent ASGI middleware
└── tests/
    ├── unit/
    │   ├── test_models_validation.py
    │   ├── test_context.py
    │   ├── test_protocol.py
    │   ├── test_client.py
    │   └── test_async_client.py
    ├── integrations/
    │   ├── test_django.py
    │   ├── test_flask.py
    │   └── test_asgi.py
    ├── conformance/
    │   └── test_shared_contract.py
    └── packaging/
        └── test_package_script.py
```

## Public Interfaces

```python
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import AbstractAsyncContextManager, AbstractContextManager
from dataclasses import dataclass
from typing import Any, TypeAlias, Union

JSONValue: TypeAlias = Union[
    None, bool, str, int, float, list["JSONValue"], dict[str, "JSONValue"]
]

@dataclass(frozen=True, slots=True)
class Event:
    email: str | None = None
    phone_number: str | None = None
    contact_name: str | None = None
    visitor_id: str | None = None
    properties: dict[str, JSONValue] | None = None

@dataclass(frozen=True, slots=True)
class Acknowledgement:
    success: bool
    message: str
    event_key: str
    validated_properties: tuple[str, ...]
    raw_body: bytes

class Client:
    def __init__(self, access_token: str, *, base_url: str = "https://server.cekat.ai",
                 timeout: float = 10.0, retry_count: int = 2,
                 http_client: httpx.Client | None = None) -> None: ...
    def user_registration(self, event: Event) -> Acknowledgement: ...
    def user_login(self, event: Event) -> Acknowledgement: ...
    def order_created(self, event: Event) -> Acknowledgement: ...
    def order_paid(self, event: Event) -> Acknowledgement: ...
    def custom_event(self, event_key: str, event: Event) -> Acknowledgement: ...
    def close(self) -> None: ...
    def __enter__(self) -> "Client": ...
    def __exit__(self, exc_type: object, exc: object, tb: object) -> None: ...

class AsyncClient:
    def __init__(self, access_token: str, *, base_url: str = "https://server.cekat.ai",
                 timeout: float = 10.0, retry_count: int = 2,
                 http_client: httpx.AsyncClient | None = None) -> None: ...
    async def user_registration(self, event: Event) -> Acknowledgement: ...
    async def user_login(self, event: Event) -> Acknowledgement: ...
    async def order_created(self, event: Event) -> Acknowledgement: ...
    async def order_paid(self, event: Event) -> Acknowledgement: ...
    async def custom_event(self, event_key: str, event: Event) -> Acknowledgement: ...
    async def aclose(self) -> None: ...
    async def __aenter__(self) -> "AsyncClient": ...
    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None: ...

def current_visitor_id() -> str | None: ...
def extract_visitor_id(headers: Mapping[str, str], cookies: Mapping[str, str]) -> str | None: ...
def visitor_scope(visitor_id: str | None) -> AbstractContextManager[None]: ...
def visitor_from_request(headers: Mapping[str, str], cookies: Mapping[str, str]) -> AbstractContextManager[None]: ...

class DjangoVisitorMiddleware: ...
class CekatVisitor:  # Flask extension
    def __init__(self, app: flask.Flask | None = None) -> None: ...
    def init_app(self, app: flask.Flask) -> None: ...
class VisitorMiddleware:  # Pure ASGI
    def __init__(self, app: ASGIApp) -> None: ...
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None: ...
```

The error constructor/attribute contract is exact:

```python
class CekatError(Exception): ...
class ValidationError(CekatError):
    def __init__(self, message: str) -> None: ...
class HttpError(CekatError):
    def __init__(self, *, status_code: int, message: str, code: str | None,
                 raw_body: bytes, attempts: int) -> None: ...
    delivery_outcome_unknown: Literal[False] = False
class AuthenticationError(HttpError): ...
class EventDefinitionNotFoundError(HttpError): ...
class ApiError(HttpError): ...
class TransportError(CekatError):
    def __init__(self, message: str, *, attempts: int,
                 cause: httpx.TransportError) -> None: ...
    delivery_outcome_unknown: Literal[True] = True
class ResponseDecodeError(CekatError):
    def __init__(self, message: str, *, status_code: int, raw_body: bytes,
                 attempts: int, cause: Exception | None = None) -> None: ...
    delivery_outcome_unknown: Literal[False] = False
```

`HttpError` exposes `status_code`, `message`, `code`, copied `raw_body`, and `attempts`; `TransportError` exposes `message`, `attempts`, and `cause`; `ResponseDecodeError` exposes `message`, `status_code=200`, copied `raw_body`, `attempts`, and optional `cause`. Exception chaining retains the underlying cause. Error `str()` and `repr()` never contain the access token or authorization header.

---

### Task 1: Verify Compatibility and Establish the Package

**Files:**
- Create: `python/scripts/verify-compatibility`
- Create: `python/docs/compatibility.md`
- Create: `python/docs/compatibility-evidence.json`
- Create: `python/pyproject.toml`
- Create: `python/src/cekat_event_sdk/__init__.py`
- Create: `python/src/cekat_event_sdk/py.typed`
- Test: `python/tests/unit/test_public_imports.py`

**Interfaces:**
- Consumes: The repository-wide support policy and initial version `0.1.0`.
- Produces: An installable `cekat_event_sdk` package exposing `__version__ = "0.1.0"`; executable metadata gate; declared `django`, `flask`, `asgi`, `fastapi`, and `test` extras.

- [ ] **Step 1: Add and run the execution-time compatibility gate before creating package metadata**

Create executable `scripts/verify-compatibility`:

```python
#!/usr/bin/env python3
import json
import platform
import sys
import urllib.request
from datetime import datetime, timezone

PACKAGES = ("httpx", "hatchling", "pytest", "pytest-asyncio", "Django", "Flask", "starlette", "fastapi")

def get_json(url: str) -> dict[str, object]:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)

observed = {}
for name in PACKAGES:
    payload = get_json(f"https://pypi.org/pypi/{name}/json")
    info = payload["info"]
    observed[name] = {"version": info["version"], "requires_python": info["requires_python"]}

result = {
    "schema_version": 1,
    "observed_at": datetime.now(timezone.utc).isoformat(),
    "executing_python": platform.python_version(),
    "python_lifecycle_source": "https://devguide.python.org/versions/",
    "framework_sources": {
        "django": "https://www.djangoproject.com/download/#supported-versions",
        "flask": "https://flask.palletsprojects.com/en/stable/versions/",
    },
    "pypi": observed,
}
json.dump(result, sys.stdout, indent=2, sort_keys=True)
print()
```

Run:

```bash
cd python
chmod +x scripts/verify-compatibility
./scripts/verify-compatibility > docs/compatibility-evidence.json
python -m json.tool docs/compatibility-evidence.json >/dev/null
```

Expected: exit `0`; every named package has non-empty `version` and `requires_python` metadata (JSON `null` is acceptable only when PyPI itself supplies it). Review the linked official lifecycle pages and record in `docs/compatibility.md` that the selected matrix includes maintained CPython branches and maintained framework lines. If Python 3.10 is outside policy or any dependency no longer supports the resulting minimum, stop before the next step and obtain an approved floor change.

- [ ] **Step 2: Write the failing package-version test**

```python
# tests/unit/test_public_imports.py
import cekat_event_sdk


def test_package_exposes_initial_version() -> None:
    assert cekat_event_sdk.__version__ == "0.1.0"
```

- [ ] **Step 3: Create exact package metadata and verify the red test**

Create `pyproject.toml` with this baseline, replacing dependency lower/upper bounds only if Step 1's recorded evidence proves they conflict with the approved support matrix:

```toml
[build-system]
requires = ["hatchling>=1,<2"]
build-backend = "hatchling.build"

[project]
name = "cekat-event-sdk"
version = "0.1.0"
description = "Cekat server-side event ingestion SDK"
requires-python = ">=3.10"
dependencies = ["httpx>=0.27,<1"]

[project.optional-dependencies]
django = ["Django>=4.2,<6"]
flask = ["Flask>=2.3,<4"]
asgi = ["starlette>=0.37,<1"]
fastapi = ["fastapi>=0.110,<1"]
test = [
  "build>=1,<2", "mypy>=1,<2", "pip-audit>=2,<3", "pytest>=8,<9",
  "pytest-asyncio>=0.24,<1", "ruff>=0.8,<1", "twine>=5,<7",
]

[tool.hatch.build.targets.wheel]
packages = ["src/cekat_event_sdk"]

[tool.pytest.ini_options]
asyncio_mode = "strict"
testpaths = ["tests"]

[tool.mypy]
python_version = "3.10"
strict = true
packages = ["cekat_event_sdk"]

[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
```

Keep framework packages out of core dependencies. Then run:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -U pip
python -m pip install -e '.[test,django,flask,asgi,fastapi]'
python -m pytest tests/unit/test_public_imports.py -q
```

Expected: FAIL with `AttributeError: module 'cekat_event_sdk' has no attribute '__version__'`.

- [ ] **Step 4: Implement only the package version and PEP 561 marker**

```python
# src/cekat_event_sdk/__init__.py
__version__ = "0.1.0"
```

Create an empty `src/cekat_event_sdk/py.typed`, then run:

```bash
python -m pytest tests/unit/test_public_imports.py -q
python -m ruff check src tests
```

Expected: version test PASS and Ruff PASS. No behavioral class or method is stubbed in this task; later tasks add each public symbol with its working implementation.

- [ ] **Step 5: Commit the verified package foundation**

```bash
git add python/pyproject.toml python/scripts/verify-compatibility python/docs python/src python/tests/unit/test_public_imports.py
git commit -m "build(python): establish verified package baseline"
```

---

### Task 2: Implement Models, Typed Errors, Strict Validation, and Visitor Context

**Files:**
- Create: `python/src/cekat_event_sdk/models.py`
- Create: `python/src/cekat_event_sdk/errors.py`
- Create: `python/src/cekat_event_sdk/validation.py`
- Create: `python/src/cekat_event_sdk/context.py`
- Modify: `python/src/cekat_event_sdk/__init__.py`
- Test: `python/tests/unit/test_models_validation.py`
- Test: `python/tests/unit/test_context.py`

**Interfaces:**
- Consumes: Public model/error signatures above.
- Produces: `validate_config(...)`, `build_payload(event_key, is_common, event, ambient_visitor_id) -> dict[str, JSONValue]`, `current_visitor_id`, `extract_visitor_id`, `visitor_scope`, and `visitor_from_request` for both clients/adapters.

- [ ] **Step 1: Write failing immutable-model and validation tests**

```python
# tests/unit/test_models_validation.py
import math
import pytest
from cekat_event_sdk import Event, ValidationError
from cekat_event_sdk.validation import build_payload, validate_config

@pytest.mark.parametrize("value", ["", " \t"])
def test_event_key_must_be_nonblank(value: str) -> None:
    with pytest.raises(ValidationError, match="event_key"):
        build_payload(value, False, Event(email="a@example.test"), None)

def test_identity_is_checked_trimmed_but_preserved() -> None:
    payload = build_payload(" custom ", False, Event(email=" a@example.test "), None)
    assert payload["event_key"] == " custom "
    assert payload["email"] == " a@example.test "

def test_phone_is_sufficient_identity() -> None:
    assert build_payload("k", False, Event(phone_number=" +1 "), None)["phone_number"] == " +1 "

def test_blank_identity_is_rejected_before_network() -> None:
    with pytest.raises(ValidationError, match="email or phone_number"):
        build_payload("k", False, Event(email=" ", phone_number="\t"), None)

def test_explicit_visitor_is_trimmed_and_wins() -> None:
    payload = build_payload("k", False, Event(email="e", visitor_id=" explicit "), "ambient")
    assert payload["visitor_id"] == "explicit"

def test_blank_explicit_visitor_falls_back() -> None:
    payload = build_payload("k", False, Event(email="e", visitor_id="  "), " ambient ")
    assert payload["visitor_id"] == "ambient"

@pytest.mark.parametrize("bad", [math.nan, math.inf, 9007199254740992, object(), ("tuple",)])
def test_properties_reject_non_interoperable_values(bad: object) -> None:
    with pytest.raises(ValidationError, match="properties") as raised:
        build_payload("k", False, Event(email="e", properties={"bad": bad}), None)  # type: ignore[dict-item]
    assert repr(bad) not in str(raised.value)

def test_properties_reject_cycles() -> None:
    cycle: dict[str, object] = {}
    cycle["self"] = cycle
    with pytest.raises(ValidationError, match=r"properties\.self"):
        build_payload("k", False, Event(email="e", properties=cycle), None)  # type: ignore[arg-type]

def test_config_rejects_invalid_values_without_token_disclosure() -> None:
    secret = " secret-token "
    with pytest.raises(ValidationError) as raised:
        validate_config(secret, "https://user:pass@example.test/path?q=1", 0, -1)
    assert secret.strip() not in str(raised.value)
```

Run: `python -m pytest tests/unit/test_models_validation.py -q`

Expected: FAIL because model and validation implementations are absent.

- [ ] **Step 2: Implement immutable models, six typed errors, and recursive validation**

Implement recursion with an active object-ID set removed in `finally`; check `bool` before `int`; accept `dict` and `list` only; include a safe key path such as `properties.customer.age` but never a value. Omit optional `None` fields, preserve identity/contact strings, and always include `properties` as supplied only when non-`None`.

Representative complete payload function:

```python
def build_payload(event_key: str, is_common: bool, event: Event,
                  ambient_visitor_id: str | None) -> dict[str, JSONValue]:
    if not isinstance(event_key, str) or not event_key.strip():
        raise ValidationError("event_key must be a non-empty string")
    email_ok = isinstance(event.email, str) and bool(event.email.strip())
    phone_ok = isinstance(event.phone_number, str) and bool(event.phone_number.strip())
    if not email_ok and not phone_ok:
        raise ValidationError("at least one non-empty email or phone_number is required")
    if event.properties is not None:
        _validate_json(event.properties, "properties", set())
    explicit = event.visitor_id.strip() if isinstance(event.visitor_id, str) else ""
    ambient = ambient_visitor_id.strip() if isinstance(ambient_visitor_id, str) else ""
    payload: dict[str, JSONValue] = {"event_key": event_key, "is_common": is_common}
    for key, value in (("email", event.email), ("phone_number", event.phone_number),
                       ("contact_name", event.contact_name)):
        if value is not None:
            payload[key] = value
    if event.properties is not None:
        payload["properties"] = event.properties
    visitor = explicit or ambient
    if visitor:
        payload["visitor_id"] = visitor
    return payload
```

- [ ] **Step 3: Run model/validation tests**

Run: `python -m pytest tests/unit/test_models_validation.py -q`

Expected: PASS, including cycle, finite-number, safe-integer, value-redaction, and visitor-precedence cases.

- [ ] **Step 4: Write failing visitor-context tests**

```python
# tests/unit/test_context.py
import asyncio
import pytest
from cekat_event_sdk.context import current_visitor_id, extract_visitor_id, visitor_from_request, visitor_scope

def test_header_wins_and_values_are_trimmed() -> None:
    assert extract_visitor_id({"x-cekat-visitor-id": " header "}, {"_cekat_visitor_id": "cookie"}) == "header"

def test_blank_header_falls_back_to_cookie() -> None:
    assert extract_visitor_id({"X-Cekat-Visitor-ID": " "}, {"_cekat_visitor_id": " cookie "}) == "cookie"

def test_nested_scope_restores_after_exception() -> None:
    with visitor_scope("outer"):
        with pytest.raises(RuntimeError):
            with visitor_from_request({"X-Cekat-Visitor-ID": "inner"}, {}):
                assert current_visitor_id() == "inner"
                raise RuntimeError("boom")
        assert current_visitor_id() == "outer"
    assert current_visitor_id() is None

@pytest.mark.asyncio
async def test_context_is_isolated_between_tasks() -> None:
    ready = asyncio.Event()
    async def read(value: str) -> str | None:
        with visitor_scope(value):
            ready.set()
            await asyncio.sleep(0)
            return current_visitor_id()
    assert await asyncio.gather(read("a"), read("b")) == ["a", "b"]
```

Run: `python -m pytest tests/unit/test_context.py -q`

Expected: FAIL because scoped context is absent.

- [ ] **Step 5: Implement `ContextVar` extraction and token reset**

```python
_current: ContextVar[str | None] = ContextVar("cekat_visitor_id", default=None)

@contextmanager
def visitor_scope(visitor_id: str | None) -> Iterator[None]:
    normalized = visitor_id.strip() if isinstance(visitor_id, str) else ""
    token = _current.set(normalized or None)
    try:
        yield
    finally:
        _current.reset(token)
```

Perform case-insensitive header lookup without modifying caller mappings. `visitor_from_request` calls `extract_visitor_id` then delegates to `visitor_scope`.

Run:

```bash
python -m pytest tests/unit/test_models_validation.py tests/unit/test_context.py -q
python -m mypy src tests/unit/test_models_validation.py tests/unit/test_context.py
```

Expected: all tests PASS and mypy reports no errors.

- [ ] **Step 6: Commit the core value and scope contract**

```bash
git add python/src/cekat_event_sdk python/tests/unit/test_models_validation.py python/tests/unit/test_context.py
git commit -m "feat(python): add validated events and visitor context"
```

---

### Task 3: Implement Bounded Protocol Decoding and Retry Policy

**Files:**
- Create: `python/src/cekat_event_sdk/protocol.py`
- Create: `python/src/cekat_event_sdk/retry.py`
- Test: `python/tests/unit/test_protocol.py`

**Interfaces:**
- Consumes: `Acknowledgement` and typed errors from Task 2.
- Produces: `decode_response(status_code, reason_phrase, raw_body, attempts, *, body_truncated=False) -> Acknowledgement`, `read_bounded(response) -> tuple[bytes, bool]`, `read_bounded_async(response) -> tuple[bytes, bool]`, `should_retry_status(status_code) -> bool`, `retry_delay_upper_bound(retry_number) -> float`, and `MAX_RESPONSE_BYTES = 65536`.

- [ ] **Step 1: Write failing response-decoding tests**

```python
# tests/unit/test_protocol.py
import json
import pytest
from cekat_event_sdk import ApiError, AuthenticationError, EventDefinitionNotFoundError, ResponseDecodeError
from cekat_event_sdk.protocol import MAX_RESPONSE_BYTES, decode_response
from cekat_event_sdk.retry import retry_delay_upper_bound, should_retry_status

def success_body() -> bytes:
    return json.dumps({"success": True, "data": {"success": True, "message": "queued",
        "event_key": "order_paid", "validated_properties": ["order_id"]}}).encode()

def test_valid_nested_success_decodes() -> None:
    ack = decode_response(200, "OK", success_body(), 1)
    assert (ack.success, ack.message, ack.event_key, ack.validated_properties) == (True, "queued", "order_paid", ("order_id",))
    assert ack.raw_body == success_body()

@pytest.mark.parametrize("body", [b"{}", b"not-json", b'{"success":true,"data":{"success":true,"message":"","event_key":"k","validated_properties":[]}}', b'{"success":true,"data":{"success":true,"message":"ok","event_key":"k","validated_properties":{}}}'])
def test_malformed_200_is_decode_error(body: bytes) -> None:
    with pytest.raises(ResponseDecodeError) as raised:
        decode_response(200, "OK", body, 1)
    assert raised.value.delivery_outcome_unknown is False
    assert len(raised.value.raw_body) <= MAX_RESPONSE_BYTES

@pytest.mark.parametrize((status, error_type), [(400, ApiError), (401, AuthenticationError), (404, EventDefinitionNotFoundError), (429, ApiError), (500, ApiError)])
def test_non_200_maps_by_status(status: int, error_type: type[Exception]) -> None:
    with pytest.raises(error_type) as raised:
        decode_response(status, "Reason", b'{"success":false,"error":"server text","code":"E1"}', 3)
    assert raised.value.message == "server text"
    assert raised.value.code == "E1"
    assert raised.value.attempts == 3
    assert raised.value.delivery_outcome_unknown is False

def test_malformed_error_keeps_status_and_reason() -> None:
    with pytest.raises(AuthenticationError) as raised:
        decode_response(401, "Unauthorized", b"\xffbroken", 1)
    assert raised.value.message == "Unauthorized"
    assert raised.value.code is None
    assert raised.value.raw_body == b"\xffbroken"

def test_body_is_bounded_by_bytes() -> None:
    body = b"x" * (MAX_RESPONSE_BYTES + 10)
    with pytest.raises(ApiError) as raised:
        decode_response(400, "Bad Request", body, 1)
    assert len(raised.value.raw_body) == MAX_RESPONSE_BYTES

def test_retry_policy_is_exact() -> None:
    assert should_retry_status(500)
    assert not any(should_retry_status(s) for s in (400, 401, 404, 429, 502))
    assert retry_delay_upper_bound(1) == 0.1
    assert retry_delay_upper_bound(2) == 0.2
    assert retry_delay_upper_bound(8) == 1.0
```

Run: `python -m pytest tests/unit/test_protocol.py -q`

Expected: FAIL because protocol helpers are absent.

- [ ] **Step 2: Implement strict decoding and error fallback**

Implement sync and async bounded readers over `response.iter_bytes()` / `response.aiter_bytes()`. Stop after observing byte 65,537, return a copied first-65,536-byte value plus `body_truncated=True`, and close the stream; never call `response.read()`, `response.aread()`, or `response.content` on an unbounded response. Parse only bounded bytes. Any truncated HTTP `200` is `ResponseDecodeError`; non-200 decoding uses only bounded bytes. Use `json.loads(raw.decode("utf-8"))`; require `type(value) is bool` where booleans are specified, and reject booleans in string/list positions. For non-200, use server text/code only when the exact authoritative envelope conforms; otherwise use `reason_phrase or f"HTTP {status_code}"` and `code=None`.

Representative status branch:

```python
error_type = (
    AuthenticationError if status_code == 401 else
    EventDefinitionNotFoundError if status_code == 404 else
    ApiError
)
raise error_type(status_code=status_code, message=message, code=code,
                 raw_body=bounded, attempts=attempts)
```

- [ ] **Step 3: Implement the pure retry helpers**

```python
def should_retry_status(status_code: int) -> bool:
    return status_code == 500

def retry_delay_upper_bound(retry_number: int) -> float:
    if retry_number < 1:
        raise ValueError("retry_number must be at least 1")
    return min(0.1 * (2 ** (retry_number - 1)), 1.0)
```

Run:

```bash
python -m pytest tests/unit/test_protocol.py -q
python -m ruff check src/cekat_event_sdk/protocol.py src/cekat_event_sdk/retry.py tests/unit/test_protocol.py
```

Expected: tests and Ruff PASS.

- [ ] **Step 4: Commit protocol behavior**

```bash
git add python/src/cekat_event_sdk/protocol.py python/src/cekat_event_sdk/retry.py python/tests/unit/test_protocol.py
git commit -m "feat(python): decode bounded protocol responses"
```

---

### Task 4: Implement the Synchronous HTTPX Client

**Files:**
- Modify: `python/src/cekat_event_sdk/client.py`
- Modify: `python/src/cekat_event_sdk/__init__.py`
- Test: `python/tests/unit/test_client.py`

**Interfaces:**
- Consumes: `build_payload`, `current_visitor_id`, `decode_response`, retry helpers.
- Produces: Complete synchronous `Client` API and deterministic internal injection points `_sleep: Callable[[float], None]` and `_uniform: Callable[[float, float], float]` accepted as private keyword-only constructor parameters for tests only.

- [ ] **Step 1: Write failing request, wrapper, and precedence tests with `httpx.MockTransport`**

```python
# tests/unit/test_client.py
import json
import httpx
from cekat_event_sdk import Client, Event
from cekat_event_sdk.context import visitor_scope

def canonical(request: httpx.Request) -> httpx.Response:
    assert request.url == "https://example.test/api/events/ingest"
    assert request.headers["Authorization"] == "Bearer token"
    return httpx.Response(200, json={"success": True, "data": {"success": True,
        "message": "queued", "event_key": json.loads(request.content)["event_key"],
        "validated_properties": []}})

def test_common_wrapper_and_context_payload() -> None:
    seen: list[dict[str, object]] = []
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)); return canonical(request)
    transport_client = httpx.Client(transport=httpx.MockTransport(handler))
    sdk = Client("token", base_url="https://example.test/", http_client=transport_client)
    with visitor_scope(" ambient "):
        ack = sdk.order_paid(Event(email=" a@example.test ", properties={"n": 1}))
    assert ack.event_key == "order_paid"
    assert seen == [{"event_key": "order_paid", "is_common": True,
                     "email": " a@example.test ", "properties": {"n": 1},
                     "visitor_id": "ambient"}]

def test_custom_event_and_explicit_visitor() -> None:
    bodies: list[dict[str, object]] = []
    client = httpx.Client(transport=httpx.MockTransport(lambda r: (bodies.append(json.loads(r.content)) or canonical(r))))
    with visitor_scope("ambient"):
        Client("token", base_url="https://example.test", http_client=client).custom_event(
            "custom", Event(phone_number="1", visitor_id=" explicit "))
    assert bodies[0]["is_common"] is False
    assert bodies[0]["visitor_id"] == "explicit"
```

Run: `python -m pytest tests/unit/test_client.py -q`

Expected: FAIL because `Client` methods are not implemented.

- [ ] **Step 2: Implement configuration, ownership, request sending, and all five wrappers**

Validate before creating HTTPX resources. Use `urllib.parse.urlsplit`, require scheme `http`/`https`, nonempty hostname, no username/password/query/fragment, and path `""` or `"/"`. Store only the normalized endpoint, never the token in `repr`. Build and send one streaming POST per attempt, with `Authorization`, JSON content type/body, and the configured timeout applied to HTTPX connect/read/write/pool phases. Do not close injected clients; close an owned client exactly once.

Complete wrapper pattern:

```python
def user_registration(self, event: Event) -> Acknowledgement:
    return self._track("user_registration", True, event)

def user_login(self, event: Event) -> Acknowledgement:
    return self._track("user_login", True, event)

def order_created(self, event: Event) -> Acknowledgement:
    return self._track("order_created", True, event)

def order_paid(self, event: Event) -> Acknowledgement:
    return self._track("order_paid", True, event)

def custom_event(self, event_key: str, event: Event) -> Acknowledgement:
    return self._track(event_key, False, event)
```

Run: `python -m pytest tests/unit/test_client.py -q`

Expected: initial wrapper tests PASS.

- [ ] **Step 3: Add failing retry, timeout, status, redaction, and ownership tests**

Add exact tests that assert:

```python
# handlers append every request; private injections make delays deterministic
assert attempts_after([500, 500, 200]) == 3
assert recorded_sleep_bounds == [0.1, 0.2]
assert attempts_after([400]) == 1
assert attempts_after([401]) == 1
assert attempts_after([404]) == 1
assert attempts_after([502]) == 1
```

Use a `MockTransport` handler that raises `httpx.ConnectError("down", request=request)` twice then succeeds, and another that always raises `httpx.ReadTimeout`. Assert three attempts, two sleeps, final `TransportError.attempts == 3`, `cause` retained, and `delivery_outcome_unknown is True`. Assert an exhausted `[500, 500, 500]` becomes `ApiError`, attempts `3`, outcome known. Assert invalid events issue zero calls. Use recording client subclasses to prove `timeout=10.0` is passed per attempt and injected clients remain open after `sdk.close()`. Assert access token absent from all error `str`/`repr`.

Run: `python -m pytest tests/unit/test_client.py -q`

Expected: FAIL on retry/lifecycle assertions.

- [ ] **Step 4: Implement the exact synchronous retry loop**

```python
for attempt in range(1, self._retry_count + 2):
    try:
        request = self._http.build_request("POST", self._endpoint, headers=self._headers,
                                           json=payload)
        response = self._http.send(request, stream=True)
    except httpx.TransportError as cause:
        if attempt <= self._retry_count:
            self._sleep(self._uniform(0.0, retry_delay_upper_bound(attempt)))
            continue
        raise TransportError("event request failed", attempts=attempt, cause=cause) from cause
    if response.status_code == 500 and attempt <= self._retry_count:
        response.close()
        self._sleep(self._uniform(0.0, retry_delay_upper_bound(attempt)))
        continue
    raw_body, body_truncated = read_bounded(response)
    return decode_response(response.status_code, response.reason_phrase, raw_body, attempt,
                           body_truncated=body_truncated)
raise AssertionError("retry loop exhausted without result")
```

Wrap every streamed response in `try/finally: response.close()`. Pass the per-attempt timeout through HTTPX request extensions (or use `with self._http.stream(..., timeout=self._timeout)` if the verified HTTPX line supports the injected-client path); tests must observe `10.0` for connect/read/write/pool. Do not catch `BaseException`.

Run:

```bash
python -m pytest tests/unit/test_client.py -q
python -m pytest tests/unit -q
```

Expected: all synchronous and unit tests PASS.

- [ ] **Step 5: Commit the synchronous client**

```bash
git add python/src/cekat_event_sdk/client.py python/src/cekat_event_sdk/__init__.py python/tests/unit/test_client.py
git commit -m "feat(python): add synchronous event client"
```

---

### Task 5: Implement the Asynchronous HTTPX Client and Cancellation Contract

**Files:**
- Modify: `python/src/cekat_event_sdk/async_client.py`
- Modify: `python/src/cekat_event_sdk/__init__.py`
- Test: `python/tests/unit/test_async_client.py`

**Interfaces:**
- Consumes: The same pure core as Task 4.
- Produces: Complete `AsyncClient`; private deterministic `_sleep: Callable[[float], Awaitable[None]]` and `_uniform` test seams; unchanged propagation of `asyncio.CancelledError`.

- [ ] **Step 1: Write failing async parity tests**

```python
# tests/unit/test_async_client.py
import asyncio
import json
import httpx
import pytest
from cekat_event_sdk import AsyncClient, Event, TransportError

@pytest.mark.asyncio
async def test_async_common_method_uses_async_transport() -> None:
    seen: list[dict[str, object]] = []
    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True, "data": {"success": True,
            "message": "queued", "event_key": "user_login", "validated_properties": []}})
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ack = await AsyncClient("token", base_url="https://example.test", http_client=http).user_login(Event(email="e"))
    assert ack.event_key == "user_login"
    assert seen[0]["is_common"] is True

@pytest.mark.asyncio
async def test_task_cancellation_during_request_propagates() -> None:
    started = asyncio.Event()
    async def handler(request: httpx.Request) -> httpx.Response:
        started.set(); await asyncio.sleep(60); raise AssertionError
    sdk = AsyncClient("token", base_url="https://example.test",
                      http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    task = asyncio.create_task(sdk.custom_event("k", Event(email="e")))
    await started.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
```

Run: `python -m pytest tests/unit/test_async_client.py -q`

Expected: FAIL because async methods are absent.

- [ ] **Step 2: Implement async construction, methods, and ownership**

Mirror validation and public operations exactly, but await `AsyncClient.post`, `asyncio.sleep`, and `aclose`. Do not implement async by calling the sync client or `asyncio.run`. Do not close injected clients.

Run: `python -m pytest tests/unit/test_async_client.py -q`

Expected: parity and request-cancellation tests PASS.

- [ ] **Step 3: Add failing async retry/backoff-cancellation tests**

Use handlers that return `[500, 500, 200]`, raise `httpx.ConnectError`, and raise `httpx.ReadTimeout`; assert the same attempt/error contract as sync. For backoff cancellation:

```python
@pytest.mark.asyncio
async def test_task_cancellation_during_backoff_propagates_without_next_attempt() -> None:
    attempts = 0
    sleeping = asyncio.Event()
    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(500, json={"success": False, "error": "retry"})
    async def blocked_sleep(delay: float) -> None:
        sleeping.set()
        await asyncio.sleep(60)
    sdk = AsyncClient("token", base_url="https://example.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), _sleep=blocked_sleep)
    task = asyncio.create_task(sdk.custom_event("k", Event(email="e")))
    await sleeping.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert attempts == 1
```

Run: `python -m pytest tests/unit/test_async_client.py -q`

Expected: FAIL until the loop awaits interruptible backoff and excludes cancellation from transport wrapping.

- [ ] **Step 4: Implement cancellation-safe async retries**

Catch `httpx.TransportError` only. In current supported Python, `asyncio.CancelledError` is not an `Exception` subclass, but explicitly avoid broad catches so that behavior remains obvious and test-enforced. Await the sleeper between attempts. Use per-request `timeout=self._timeout`.

Run:

```bash
python -m pytest tests/unit/test_async_client.py -q
python -m pytest tests/unit -q
python -m mypy src tests
```

Expected: all tests PASS; cancellation escapes unchanged; mypy reports no errors.

- [ ] **Step 5: Commit the asynchronous client**

```bash
git add python/src/cekat_event_sdk/async_client.py python/src/cekat_event_sdk/__init__.py python/tests/unit/test_async_client.py
git commit -m "feat(python): add cancellable asynchronous client"
```

---

### Task 6: Add Sync/Async Django Middleware

**Files:**
- Create: `python/src/cekat_event_sdk/integrations/__init__.py`
- Create: `python/src/cekat_event_sdk/integrations/django.py`
- Test: `python/tests/integrations/test_django.py`

**Interfaces:**
- Consumes: `visitor_from_request` and `current_visitor_id`.
- Produces: `DjangoVisitorMiddleware(get_response)` supporting native sync and async Django handlers without thread-local state.

- [ ] **Step 1: Write failing sync, async, precedence, exception-cleanup, and concurrency tests**

Use `django.test.RequestFactory` and `AsyncRequestFactory`. Configure minimal Django settings inside the test module. Assert:

```python
def sync_view(request):
    observed.append(current_visitor_id())
    return HttpResponse("ok")

middleware = DjangoVisitorMiddleware(sync_view)
response = middleware(RequestFactory().get("/", HTTP_X_CEKAT_VISITOR_ID=" header ",
                                           HTTP_COOKIE="_cekat_visitor_id=cookie"))
assert response.status_code == 200
assert observed == ["header"]
assert current_visitor_id() is None
```

Add an async view with `await asyncio.sleep(0)`, two concurrent requests returning distinct visitor IDs, cookie fallback, blank-header fallback, no-value case, and handlers raising exceptions. In every case assert restoration to an outer visitor scope and no cross-request leakage.

Run: `python -m pytest tests/integrations/test_django.py -q`

Expected: FAIL because middleware is absent.

- [ ] **Step 2: Implement dual-capability Django middleware**

```python
class DjangoVisitorMiddleware:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response: Callable[..., HttpResponseBase]) -> None:
        self.get_response = get_response
        self._is_async = iscoroutinefunction(get_response)
        if self._is_async:
            markcoroutinefunction(self)

    def __call__(self, request: HttpRequest) -> HttpResponseBase | Awaitable[HttpResponseBase]:
        if self._is_async:
            return self.__acall__(request)
        with visitor_from_request(request.headers, request.COOKIES):
            return self.get_response(request)

    async def __acall__(self, request: HttpRequest) -> HttpResponseBase:
        with visitor_from_request(request.headers, request.COOKIES):
            return await self.get_response(request)
```

Keep Django imports isolated to this integration module. Do not mutate requests, set cookies, inspect users, or emit events.

Run:

```bash
python -m pytest tests/integrations/test_django.py -q
python -m mypy src/cekat_event_sdk/integrations/django.py tests/integrations/test_django.py
```

Expected: all Django tests PASS and mypy reports no errors.

- [ ] **Step 3: Commit Django support**

```bash
git add python/src/cekat_event_sdk/integrations python/tests/integrations/test_django.py
git commit -m "feat(python): add Django visitor middleware"
```

---

### Task 7: Add Flask Request Hooks

**Files:**
- Create: `python/src/cekat_event_sdk/integrations/flask.py`
- Test: `python/tests/integrations/test_flask.py`

**Interfaces:**
- Consumes: `extract_visitor_id`, `visitor_scope`, `current_visitor_id`.
- Produces: `CekatVisitor(app=None)` extension registering request setup and teardown once per Flask app.

- [ ] **Step 1: Write failing Flask lifecycle tests**

Build an app factory with routes that return `current_visitor_id()`, raise, and perform an SDK call through `MockTransport`. Assert header-over-cookie, trimmed transmission, cookie fallback, blank-header fallback, cleanup after success and exception, and sequential request isolation on one test client. Ensure initializing the extension twice does not register duplicate teardown/reset behavior.

```python
def test_flask_header_wins_and_context_clears(app: Flask) -> None:
    client = app.test_client()
    client.set_cookie("_cekat_visitor_id", "cookie")
    response = client.get("/visitor", headers={"X-Cekat-Visitor-ID": " header "})
    assert response.text == "header"
    assert current_visitor_id() is None
```

Run: `python -m pytest tests/integrations/test_flask.py -q`

Expected: FAIL because `CekatVisitor` is absent.

- [ ] **Step 2: Implement Flask setup/teardown using an entered context manager**

Store the entered scope manager on `flask.g` under a private extension-specific name; in `before_request`, extract scalar values from `request.headers`/`request.cookies`, enter `visitor_scope`, and store it. In `teardown_request`, pop and exit exactly once regardless of exception. Mark app initialization in `app.extensions["cekat_event_sdk"]` and reject conflicting duplicate extension instances with `RuntimeError`.

```python
def _before_request() -> None:
    manager = visitor_scope(extract_visitor_id(request.headers, request.cookies))
    manager.__enter__()
    g._cekat_visitor_scope = manager

def _teardown_request(error: BaseException | None) -> None:
    manager = g.pop("_cekat_visitor_scope", None)
    if manager is not None:
        manager.__exit__(None, None, None)
```

Run:

```bash
python -m pytest tests/integrations/test_flask.py -q
python -m pytest tests/integrations/test_django.py tests/integrations/test_flask.py -q
```

Expected: all Flask and Django integration tests PASS.

- [ ] **Step 3: Commit Flask support**

```bash
git add python/src/cekat_event_sdk/integrations/flask.py python/tests/integrations/test_flask.py
git commit -m "feat(python): add Flask visitor integration"
```

---

### Task 8: Add Pure ASGI Middleware for Starlette and FastAPI

**Files:**
- Create: `python/src/cekat_event_sdk/integrations/asgi.py`
- Test: `python/tests/integrations/test_asgi.py`

**Interfaces:**
- Consumes: visitor context APIs.
- Produces: framework-independent `VisitorMiddleware` implementing the ASGI 3 callable; no dependency on `BaseHTTPMiddleware`.

- [ ] **Step 1: Write failing raw-ASGI, Starlette, and FastAPI tests**

Test HTTP scopes with duplicate/raw lowercase headers, cookie parsing via `http.cookies.SimpleCookie`, non-HTTP passthrough, response streaming, application exceptions, task cancellation, and concurrent requests. Mount the same middleware around both Starlette and FastAPI applications; assert event methods called after an `await` observe the correct request visitor.

```python
@pytest.mark.asyncio
async def test_asgi_concurrent_isolation() -> None:
    async def app(scope, receive, send):
        await asyncio.sleep(0)
        body = (current_visitor_id() or "none").encode()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": body})
    wrapped = VisitorMiddleware(app)
    assert await asyncio.gather(run_asgi(wrapped, "a"), run_asgi(wrapped, "b")) == [b"a", b"b"]
    assert current_visitor_id() is None
```

Run: `python -m pytest tests/integrations/test_asgi.py -q`

Expected: FAIL because middleware is absent.

- [ ] **Step 2: Implement pure ASGI extraction and full-call scope**

For `scope["type"] != "http"`, call the application directly. Decode ASGI header names/values using Latin-1, pick the first nonblank visitor header, parse all Cookie headers into a scalar cookie mapping, and establish context around the entire downstream call.

```python
async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] != "http":
        await self.app(scope, receive, send)
        return
    headers = _headers_from_scope(scope)
    cookies = _cookies_from_headers(scope)
    with visitor_from_request(headers, cookies):
        await self.app(scope, receive, send)
```

Do not buffer request/response bodies, spawn a new task, mutate the ASGI scope, or swallow `CancelledError`/application exceptions.

Run:

```bash
python -m pytest tests/integrations/test_asgi.py -q
python -m pytest tests/integrations -q
```

Expected: all adapter tests PASS, including streaming and cancellation cleanup.

- [ ] **Step 3: Commit ASGI support**

```bash
git add python/src/cekat_event_sdk/integrations/asgi.py python/tests/integrations/test_asgi.py
git commit -m "feat(python): add pure ASGI visitor middleware"
```

---

### Task 9: Wire Shared Conformance Fixtures and Stable Runner

**Files:**
- Create: `python/tests/conformance/test_shared_contract.py`
- Create: `python/scripts/conformance`
- Modify: `python/pyproject.toml`

**Interfaces:**
- Consumes: every direct `*.json` child of the absolute cases directory named by `CEKAT_CONFORMANCE_FIXTURES`; running mock server ingest origin from `CEKAT_CONFORMANCE_BASE_URL`; control API origin from `CEKAT_CONFORMANCE_CONTROL_URL`; SDK token from `CEKAT_CONFORMANCE_ACCESS_TOKEN`.
- Produces: executable `<repo>/python/scripts/conformance`, called without positional arguments by the root runner. It reads exactly those four `CEKAT_CONFORMANCE_*` variables—no aliases, defaults, repository-relative fixture paths, or additional conformance variables.

- [ ] **Step 1: Write fixture loader and failing end-to-end cases**

The conformance module must fail at collection with a clear message if any of the four variables is absent, if base/control is not an absolute HTTP(S) origin without path/query/fragment/credentials, or if fixtures is not an absolute readable directory. Discover with `Path(CEKAT_CONFORMANCE_FIXTURES).iterdir()` and select every direct `*.json` file; reject an empty corpus, duplicate IDs, filename/ID mismatch, nested case files, unknown `schema_version`, operation name, `properties_recipe`, `response_body_recipe` unit/form, cancellation phase, mock-response field/form, or `expect.result`. Explicit filename lists and silent pytest skips/xfails are forbidden. Any skipped required case is a hard failure. Maintain discovered and executed ID sets and fail suite teardown unless they are equal and every required case produced its result, attempt, control, and journal assertions.

Use an `httpx.Client` only for mock controls and the public SDK clients for ingest. Construct SDK clients with `CEKAT_CONFORMANCE_ACCESS_TOKEN` and `CEKAT_CONFORMANCE_BASE_URL`; controls must use only `CEKAT_CONFORMANCE_CONTROL_URL`.

Exact control helper:

```python
BASE_URL = os.environ["CEKAT_CONFORMANCE_BASE_URL"]
CONTROL_URL = os.environ["CEKAT_CONFORMANCE_CONTROL_URL"]
ACCESS_TOKEN = os.environ["CEKAT_CONFORMANCE_ACCESS_TOKEN"]
FIXTURES = Path(os.environ["CEKAT_CONFORMANCE_FIXTURES"])

def queue(*responses: dict[str, object]) -> None:
    reset = httpx.post(f"{CONTROL_URL}/__control/reset", content=b"")
    reset.raise_for_status()
    queued = httpx.post(
        f"{CONTROL_URL}/__control/responses",
        json={"responses": list(responses)},
    )
    queued.raise_for_status()
    assert queued.status_code == 204

def journal() -> list[dict[str, object]]:
    response = httpx.get(f"{CONTROL_URL}/__control/requests")
    response.raise_for_status()
    payload = response.json()
    assert isinstance(payload, dict) and set(payload) == {"requests"}
    requests = payload["requests"]
    assert isinstance(requests, list)
    assert all(isinstance(item, dict) for item in requests)
    return requests
```

Implement exhaustive dispatcher functions rather than test-name selection: expand every response-body recipe, build every Python-only properties recipe, apply inbound header/cookie/ambient scope, invoke all five operation forms, and use `AsyncClient` for caller-cancellation phases. For each case reset and queue controls, execute it once, then assert the exact expected result form including caller-visible `error_message`, acknowledgement, attempts, outcome certainty, retained bytes, request count/order/path/auth/content type/payload, and jitter bounds. Cover sync/async parity separately without marking one execution as two fixture cases.

Run from repository root with the shared server already listening:

```bash
CEKAT_CONFORMANCE_BASE_URL=http://127.0.0.1:18080 \
CEKAT_CONFORMANCE_CONTROL_URL=http://127.0.0.1:18080 \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
  python/.venv/bin/python -m pytest python/tests/conformance -q
```

Expected: FAIL until any fixture-to-Python mapping omission is corrected; every discovered fixture ID is printed exactly once and no test may reach the production origin.

- [ ] **Step 2: Fix only Python conformance gaps and add the stable executable**

Create `scripts/conformance`:

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 0 ] || { echo "conformance accepts no positional arguments" >&2; exit 2; }
: "${CEKAT_CONFORMANCE_BASE_URL:?required}"
: "${CEKAT_CONFORMANCE_CONTROL_URL:?required}"
: "${CEKAT_CONFORMANCE_ACCESS_TOKEN:?required}"
: "${CEKAT_CONFORMANCE_FIXTURES:?required}"
cd "$(dirname "$0")/.."
exec python -m pytest tests/conformance -q
```

Run it against the shared process interface, not a language-local launcher:

```bash
chmod +x python/scripts/conformance
cd conformance/mock-ingest-server
go build -o /tmp/cekat-python-mock ./cmd/mock-ingest-server
: > /tmp/cekat-python-mock.ready
/tmp/cekat-python-mock --listen 127.0.0.1:0 > /tmp/cekat-python-mock.ready 2>/tmp/cekat-python-mock.err & mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true; wait "$mock_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 200); do [ -s /tmp/cekat-python-mock.ready ] && break; kill -0 "$mock_pid" 2>/dev/null || exit 1; sleep 0.05; done
read -r base_url control_url <<EOF
$(python3 -c 'import json; r=json.loads(open("/tmp/cekat-python-mock.ready").readline()); print(r["base_url"], r["control_url"])')
EOF
cd ../..
CEKAT_CONFORMANCE_BASE_URL="$base_url" \
CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
  python/scripts/conformance
```

Expected: readiness JSON parses and all Python shared conformance cases PASS; every discovered case is executed exactly once, mock controls use only the control origin, the journal shows at most three attempts for default clients, and no ingest request has a path other than `/api/events/ingest`.

- [ ] **Step 3: Run the complete Python verification set**

```bash
python -m pytest -q
python -m ruff check src tests
python -m ruff format --check src tests
python -m mypy src tests
```

Expected: all tests PASS; lint/format/type checks return exit `0`.

- [ ] **Step 4: Commit conformance integration**

```bash
git add python/tests/conformance python/scripts/conformance python/pyproject.toml
git commit -m "test(python): enforce shared SDK conformance"
```

---

### Task 10: Document the SDK and Add Deterministic No-Publish Packaging

**Files:**
- Create: `python/README.md`
- Create: `python/scripts/package`
- Test: `python/tests/packaging/test_package_script.py`
- Modify: `python/pyproject.toml` (add `readme = "README.md"` after the complete README exists)
- Modify: `python/docs/compatibility.md`

**Interfaces:**
- Consumes: complete SDK, version `0.1.0`, output directory supplied by root release-readiness.
- Produces: `python/scripts/package --version 0.1.0 --output <absolute-dir>` and `<output>/manifest.json` with `schema_version`, `language`, `version`, and sorted artifact entries `{path, sha256, size_bytes}`.

- [ ] **Step 1: Write the failing packaging-contract test**

```python
# tests/packaging/test_package_script.py
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]

def test_package_script_builds_verified_manifest(tmp_path: pathlib.Path) -> None:
    output = tmp_path / "artifacts"
    subprocess.run([str(ROOT / "scripts/package"), "--version", "0.1.0",
                    "--output", str(output.resolve())], check=True)
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["schema_version"] == 1
    assert manifest["language"] == "python"
    assert manifest["version"] == "0.1.0"
    paths = [entry["path"] for entry in manifest["artifacts"]]
    assert paths == sorted(paths)
    assert paths
    for entry in manifest["artifacts"]:
        path = pathlib.PurePosixPath(entry["path"])
        assert not path.is_absolute() and ".." not in path.parts
        body = (output / path).read_bytes()
        assert entry["sha256"] == hashlib.sha256(body).hexdigest()
        assert entry["size_bytes"] == len(body)

def test_package_script_rejects_version_and_relative_output(tmp_path: pathlib.Path) -> None:
    for args in (("--version", "1.0.0", "--output", str(tmp_path.resolve())),
                 ("--version", "0.1.0", "--output", "relative")):
        result = subprocess.run([str(ROOT / "scripts/package"), *args], capture_output=True)
        assert result.returncode != 0
```

Run: `python -m pytest tests/packaging/test_package_script.py -q`

Expected: FAIL because `scripts/package` does not exist.

- [ ] **Step 2: Write user-facing documentation before packaging**

Document complete sync and async examples, ownership rules, all five methods, middleware installation for Django/Flask/FastAPI/Starlette, low-level `visitor_scope`/`visitor_from_request`, header-over-cookie and explicit-over-ambient precedence, origin-only `base_url`, timeout/retry defaults, exact retry statuses, cancellation propagation, six error classes, bounded bodies, `delivery_outcome_unknown`, and acknowledgement limitations. Include this runnable async example:

```python
import asyncio
from cekat_event_sdk import AsyncClient, Event

async def main() -> None:
    async with AsyncClient("server-access-token") as client:
        acknowledgement = await client.order_paid(Event(
            email="ada@example.com",
            properties={"order_id": "ord_123", "total": 12500},
        ))
        print(acknowledgement.event_key, acknowledgement.message)

asyncio.run(main())
```

State that backend tokens must never be used in browser code; later background jobs send identity without browser context; retries can duplicate events; acknowledgement means accepted for asynchronous processing only. In `docs/compatibility.md`, explain execution-time and release-time gates and link official lifecycle sources without claiming unverified future patch versions.

Run: `grep -RInE 'TO.DO|T.BD|simila[r] to' README.md docs src tests scripts || true`

Expected: no placeholder-language matches.

- [ ] **Step 3: Implement the package script with exact argument and manifest rules**

Add `readme = "README.md"` to `[project]`. Use Bash for orchestration and an embedded Python block for portable hashing/JSON. Require exactly version `0.1.0`, an absolute output directory, and an initially absent or empty output directory. Run `python -m pytest --ignore=tests/packaging/test_package_script.py`, Ruff, and mypy; the self-test is excluded only to prevent recursive invocation and runs immediately outside the script. Then run `python -m build --outdir "$output"` and `python -m twine check "$output"/*`. Hash only built wheel/sdist files, use output-relative POSIX paths, sort by path, and write `manifest.json` atomically via `manifest.json.tmp` plus `os.replace`.

Representative complete manifest generator:

```python
import hashlib, json, os, pathlib, sys
out = pathlib.Path(sys.argv[1]).resolve()
artifacts = []
for path in sorted(p for p in out.iterdir() if p.name != "manifest.json" and p.is_file()):
    body = path.read_bytes()
    artifacts.append({"path": path.relative_to(out).as_posix(),
                      "sha256": hashlib.sha256(body).hexdigest(),
                      "size_bytes": len(body)})
if not artifacts:
    raise SystemExit("no package artifacts were built")
data = {"schema_version": 1, "language": "python", "version": "0.1.0",
        "artifacts": artifacts}
tmp = out / "manifest.json.tmp"
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
os.replace(tmp, out / "manifest.json")
```

Run:

```bash
chmod +x scripts/package
python -m pytest tests/packaging/test_package_script.py -q
```

Expected: packaging tests PASS; generated wheel and sdist both pass Twine checks and hashes match.

- [ ] **Step 4: Run the release-time compatibility gate and dependency/security checks**

```bash
./scripts/verify-compatibility > docs/compatibility-evidence.json
python -m json.tool docs/compatibility-evidence.json >/dev/null
python -m pip check
python -m pip list --outdated
python -m pip audit
```

Expected: metadata gate, `pip check`, and vulnerability audit return exit `0`. Review Python, Django, Flask, Starlette, FastAPI, HTTPX, and Hatchling official support/metadata again. If the supported matrix or constraints differ from execution-time evidence, stop package preparation, update and test the approved compatibility matrix, then rerun all commands; never silently publish an unverified matrix.

- [ ] **Step 5: Run final validation and produce local artifacts without publishing or signing**

```bash
python -m pytest -q
python -m ruff check src tests
python -m ruff format --check src tests
python -m mypy src tests
rm -rf /tmp/cekat-python-0.1.0
./scripts/package --version 0.1.0 --output /tmp/cekat-python-0.1.0
python -m json.tool /tmp/cekat-python-0.1.0/manifest.json
```

Expected: all checks PASS; manifest lists a `0.1.0` wheel and source distribution with valid SHA-256 and byte size. No registry command runs, no credentials are read, and no artifact is signed; publication/signing remain release-owner gates.

- [ ] **Step 6: Commit documentation and package preparation**

```bash
git add python/README.md python/docs python/scripts/package python/tests/packaging python/pyproject.toml
git commit -m "build(python): prepare verified package artifacts"
```

---

## Final Acceptance Checklist

- [ ] `Client` and `AsyncClient` pass equivalent payload, envelope, retry, and error tests.
- [ ] Only HTTP `500`, HTTPX transport failures, and eligible HTTPX timeouts retry; default total attempts never exceeds three.
- [ ] Async request and backoff cancellation propagate `asyncio.CancelledError` unchanged and make no further attempt.
- [ ] Invalid configuration/events/properties produce `ValidationError` before networking and do not disclose property values or tokens.
- [ ] Every response/error retains at most 65,536 bytes; malformed `200` is the only response shape classified as `ResponseDecodeError`.
- [ ] Explicit, header, cookie, and absent visitor cases obey approved trimmed precedence.
- [ ] `ContextVar` tokens restore nested state under normal return, exception, cancellation, and concurrent asyncio tasks.
- [ ] Django sync/async, Flask, Starlette, and FastAPI tests prove request cleanup and isolation; ASGI middleware remains pure and streaming-safe.
- [ ] Injected HTTPX clients remain caller-owned; SDK-created clients close under sync/async context managers.
- [ ] `python/scripts/conformance` passes against the Go mock server and is executable.
- [ ] `python/scripts/package --version 0.1.0 --output <absolute-dir>` produces checked wheel/sdist artifacts and a traversal-safe deterministic manifest without publishing/signing.
- [ ] Execution-time and release-time compatibility evidence is recorded from official sources; no projected patch version is claimed.
- [ ] `python -m pytest -q`, Ruff check/format, mypy, build, Twine check, `pip check`, and vulnerability audit all pass.
- [ ] Git history contains focused commits for package foundation, core/context, protocol, sync client, async client, each adapter group, conformance, and packaging/docs.
