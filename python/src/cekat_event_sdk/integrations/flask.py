"""Flask extension that scopes the inbound visitor ID for each request.

app = Flask(__name__)
CekatVisitor(app)  # or CekatVisitor().init_app(app) in an application factory
"""

from __future__ import annotations

from contextlib import AbstractContextManager

from flask import Flask, g, request

from ..context import extract_visitor_id, visitor_scope

__all__ = ["CekatVisitor"]

_EXTENSION = "cekat_event_sdk"
_SCOPE = "_cekat_visitor_scope"


class CekatVisitor:
    def __init__(self, app: Flask | None = None) -> None:
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Flask) -> None:
        registered = app.extensions.get(_EXTENSION)
        if registered is self:
            return
        if registered is not None:
            raise RuntimeError("a different CekatVisitor is already registered on this Flask app")
        app.extensions[_EXTENSION] = self
        app.before_request(_enter)
        app.teardown_request(_exit)


def _enter() -> None:
    _exit(None)
    scope = visitor_scope(extract_visitor_id(request.headers.items(), request.cookies))
    scope.__enter__()
    setattr(g, _SCOPE, scope)


def _exit(error: BaseException | None) -> None:
    scope: AbstractContextManager[None] | None = g.pop(_SCOPE, None)
    if scope is not None:
        scope.__exit__(None, None, None)
