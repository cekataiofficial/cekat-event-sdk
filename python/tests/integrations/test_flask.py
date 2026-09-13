from __future__ import annotations

from typing import Any

import httpx
import pytest
from flask import Flask, jsonify, request

from cekat_event_sdk import Client, Event, current_visitor_id
from cekat_event_sdk.integrations.flask import CekatVisitor
from tests.support import recording


@pytest.fixture
def sent() -> list[dict[str, Any]]:
    return []


@pytest.fixture
def app(sent: list[dict[str, Any]]) -> Flask:
    sdk = Client(
        "token",
        base_url="https://example.test",
        http_client=httpx.Client(transport=httpx.MockTransport(recording(sent, "user_login"))),
    )
    app = Flask(__name__)
    app.config["TESTING"] = True
    CekatVisitor(app)

    @app.get("/visitor")
    def visitor() -> str:
        return current_visitor_id() or "none"

    @app.post("/login")
    def login() -> Any:
        form = request.get_json()
        ack = sdk.user_login(Event(email=form["email"]))
        return jsonify(event_key=ack.event_key, visitor=current_visitor_id())

    @app.get("/boom")
    def boom() -> str:
        raise RuntimeError("boom")

    return app


def test_header_wins_and_context_clears(app: Flask) -> None:
    client = app.test_client()
    client.set_cookie("_cekat_visitor_id", "cookie")
    response = client.get("/visitor", headers={"X-Cekat-Visitor-ID": " header "})
    assert response.text == "header"
    assert current_visitor_id() is None


def test_cookie_fallback_and_sequential_isolation(app: Flask) -> None:
    client = app.test_client()
    client.set_cookie("_cekat_visitor_id", "c")
    assert client.get("/visitor", headers={"X-Cekat-Visitor-ID": "  "}).text == "c"
    client.delete_cookie("_cekat_visitor_id")
    assert client.get("/visitor").text == "none"


def test_raw_wsgi_cookie_is_trimmed(app: Flask) -> None:
    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/visitor",
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "80",
        "wsgi.url_scheme": "http",
        "HTTP_COOKIE": "a=1; _cekat_visitor_id= raw ",
    }
    from werkzeug.test import run_wsgi_app

    body, status, _ = run_wsgi_app(app, environ)
    assert status == "200 OK"
    assert b"".join(body) == b"raw"


def test_post_body_and_sdk_call(app: Flask, sent: list[dict[str, Any]]) -> None:
    response = app.test_client().post(
        "/login", json={"email": "a@example.test"}, headers={"X-Cekat-Visitor-ID": "v"}
    )
    assert response.get_json() == {"event_key": "user_login", "visitor": "v"}
    assert sent[0]["visitor_id"] == "v"


def test_exception_cleans_up(app: Flask) -> None:
    app.config["TESTING"] = False
    response = app.test_client().get("/boom", headers={"X-Cekat-Visitor-ID": "v"})
    assert response.status_code == 500
    assert current_visitor_id() is None


def test_init_app_is_idempotent_and_rejects_conflicts(app: Flask) -> None:
    extension = app.extensions["cekat_event_sdk"]
    before = len(app.teardown_request_funcs[None])
    extension.init_app(app)
    assert len(app.teardown_request_funcs[None]) == before
    with pytest.raises(RuntimeError):
        CekatVisitor(app)
    factory_app = Flask("factory")
    CekatVisitor().init_app(factory_app)
    assert "cekat_event_sdk" in factory_app.extensions
