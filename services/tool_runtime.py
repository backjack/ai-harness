"""Convert trusted, database-stored Python functions into LangChain tools."""

from typing import Any

from langchain_core.tools import StructuredTool

class ToolFunctionValidationError(ValueError):
    """Raised when an agent's inline tool definition is invalid."""


def validate_tool_definitions(records: list[dict[str, Any]]) -> None:
    """Validate unique names and callable source for agent-owned tools."""
    names = [record["name"] for record in records]
    if len(set(names)) != len(names):
        raise ToolFunctionValidationError("Agent tooling cannot contain duplicate tool names")
    for record in records:
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
    """Load stored Python functions. Source is trusted application-process code."""
    tools: list[StructuredTool] = []
    for record in records:
        if not record.get("enabled", True):
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
