"""Shared configuration for remote Streamable HTTP MCP clients."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mcp.client.caching import CacheConfig, InMemoryResponseCacheStore


MCP_TOOL_CACHE_TTL_MS = 5 * 60 * 1000
MCP_SESSION_RETRY_ATTEMPTS = 5
_MCP_TOOL_CACHE = InMemoryResponseCacheStore(max_entries=256)
_ResultT = TypeVar("_ResultT")
logger = logging.getLogger(__name__)


class _PostOnlyMcpNoiseFilter(logging.Filter):
    """Hide optional transport noise emitted by POST-only MCP servers."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if record.name == "mcp.client.streamable_http":
            return not message.startswith("GET stream disconnected, reconnecting")
        if record.name == "httpx2":
            return not (
                "HTTP Request: GET " in message
                and '"HTTP/1.1 405 Method Not Allowed"' in message
            )
        return True


_NOISE_FILTER = _PostOnlyMcpNoiseFilter()


def _install_post_only_noise_filter() -> None:
    for logger_name in ("mcp.client.streamable_http", "httpx2"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, _PostOnlyMcpNoiseFilter) for item in logger.filters):
            logger.addFilter(_NOISE_FILTER)


def create_mcp_client(endpoint: str):
    """Return an MCP client compatible with servers that only support POST."""
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client

    _install_post_only_noise_filter()
    transport = streamable_http_client(endpoint, terminate_on_close=False)
    cache = CacheConfig(
        store=_MCP_TOOL_CACHE,
        partition="anonymous",
        target_id=endpoint,
        default_ttl_ms=MCP_TOOL_CACHE_TTL_MS,
    )
    return Client(transport, cache=cache)


def _is_session_terminated(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_session_terminated(child) for child in exc.exceptions)
    return type(exc).__name__ == "MCPError" and str(exc).strip() == "Session terminated"


async def _retry_terminated_session(
    operation: Callable[[], Awaitable[_ResultT]],
    *,
    endpoint: str,
    operation_name: str,
) -> _ResultT:
    for attempt in range(1, MCP_SESSION_RETRY_ATTEMPTS + 1):
        try:
            return await operation()
        except Exception as exc:
            if not _is_session_terminated(exc) or attempt == MCP_SESSION_RETRY_ATTEMPTS:
                raise
            logger.warning(
                "MCP session terminated during %s for %s; reconnecting (%s/%s)",
                operation_name,
                endpoint,
                attempt,
                MCP_SESSION_RETRY_ATTEMPTS,
            )
            await asyncio.sleep(0.2 * attempt)
    raise RuntimeError("MCP session retry loop ended unexpectedly")  # pragma: no cover


async def list_mcp_tools(endpoint: str, *, refresh: bool = False):
    """List tools with bounded reconnects for short-lived remote sessions."""
    async def list_tools():
        async with create_mcp_client(endpoint) as client:
            return await client.list_tools(cache_mode="refresh" if refresh else "use")

    return await _retry_terminated_session(list_tools, endpoint=endpoint, operation_name="tool metadata lookup")


async def call_mcp_tool(endpoint: str, name: str, arguments: dict[str, Any]):
    """Call a tool on a fresh session after caching its metadata separately."""
    async def execute():
        async with create_mcp_client(endpoint) as execution_client:
            # This is served from the shared cache and primes SDK result validation
            # without consuming the server's single live request for this session.
            await execution_client.list_tools()
            return await execution_client.call_tool(name, arguments)

    await list_mcp_tools(endpoint)
    return await _retry_terminated_session(execute, endpoint=endpoint, operation_name=f"tool call {name}")
