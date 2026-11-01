"""Convert trusted, database-stored Python functions into LangChain tools."""

from typing import Any

from langchain_core.tools import StructuredTool

from services.mcp_client import call_mcp_tool

class ToolFunctionValidationError(ValueError):
    """Raised when an agent's inline tool definition is invalid."""


def validate_tool_definitions(records: list[dict[str, Any]]) -> None:
    """Validate unique names and callable source for agent-owned tools."""
    names = [record["name"] for record in records]
    if len(set(names)) != len(names):
        raise ToolFunctionValidationError("Agent tooling cannot contain duplicate tool names")
    for record in records:
        if record.get("connection_type") == "mcp":
            continue
        namespace: dict[str, Any] = {"__name__": "agent_tool_validation"}
        try:
            exec(
                compile(record["source_code"], f"<tool:{record['name']}>", "exec"),
                namespace,
                namespace,
            )
        except Exception as exc:
            raise ToolFunctionValidationError(
                f"Tool source cannot be compiled: {exc}"
            ) from exc
        if not callable(namespace.get(record["name"])):
            raise ToolFunctionValidationError(
                f"Tool source must define a callable named '{record['name']}'"
            )


def build_langchain_tools(records: list[dict[str, Any]]) -> list[StructuredTool]:
    """Load trusted Python functions and available remote MCP tools."""
    tools: list[StructuredTool] = []
    for record in records:
        if not record.get("enabled", True) or record.get("approval_policy", "automatic") != "automatic":
            continue
        if record.get("connection_type") == "mcp":
            endpoint = record.get("endpoint")
            if not endpoint or record.get("status") != "available" or record.get("source_status") != "available":
                continue
            external_name = record.get("external_name") or record["name"]
            defaults = record.get("defaults") or {}

            async def invoke_mcp(
                _endpoint: str = endpoint,
                _external_name: str = external_name,
                _defaults: dict[str, Any] = defaults,
                **arguments: Any,
            ) -> dict[str, Any]:
                result = await call_mcp_tool(
                    _endpoint,
                    _external_name,
                    {**_defaults, **arguments},
                )
                return result.model_dump(mode="json")

            tools.append(
                StructuredTool.from_function(
                    coroutine=invoke_mcp,
                    name=external_name,
                    description=record["description"],
                    args_schema=record.get("input_schema") or {"type": "object", "properties": {}},
                    infer_schema=False,
                )
            )
            continue
        namespace: dict[str, Any] = {"__name__": "stored_tool_runtime"}
        try:
            exec(
                compile(record["source_code"], f"<tool:{record['name']}>", "exec"),
                namespace,
                namespace,
            )
            function = namespace[record["name"]]
        except Exception as exc:
            raise ToolFunctionValidationError(
                f"Unable to load tool '{record['name']}': {exc}"
            ) from exc
        tools.append(
            StructuredTool.from_function(
                function,
                name=record["name"],
                description=record["description"],
            )
        )
    return tools
