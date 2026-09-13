"""Cekat event SDK for Python backends."""

from ._version import __version__
from .async_client import AsyncClient
from .client import Client
from .context import current_visitor_id, extract_visitor_id, visitor_from_request, visitor_scope
from .errors import (
    ApiError,
    AuthenticationError,
    CekatError,
    EventDefinitionNotFoundError,
    HttpError,
    ResponseDecodeError,
    TransportError,
    ValidationError,
)
from .models import Acknowledgement, Event

__all__ = [
    "Acknowledgement",
    "ApiError",
    "AsyncClient",
    "AuthenticationError",
    "CekatError",
    "Client",
    "Event",
    "EventDefinitionNotFoundError",
    "HttpError",
    "ResponseDecodeError",
    "TransportError",
    "ValidationError",
    "__version__",
    "current_visitor_id",
    "extract_visitor_id",
    "visitor_from_request",
    "visitor_scope",
]
