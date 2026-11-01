"""Shared configuration for remote Streamable HTTP MCP clients."""

import logging


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
    return Client(transport)
