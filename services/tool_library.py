"""Persistent tool library, MCP discovery, and playground execution."""

from contextlib import closing
import json
import logging
import time
from typing import Any
from uuid import uuid4

from mysql.connector import Error

from services.mcp_client import call_mcp_tool, list_mcp_tools
from services.tool_runtime import build_langchain_tools, validate_tool_definitions
from utils.database import DatabaseUnavailableError, get_connection_pool


JSON_FIELDS = {"input_schema", "output_schema", "examples", "output_preview"}
logger = logging.getLogger(__name__)


def _decode(row: dict[str, Any]) -> dict[str, Any]:
    for field in JSON_FIELDS:
        if isinstance(row.get(field), str):
            row[field] = json.loads(row[field])
    return row


def _database_error(message: str, exc: Error) -> DatabaseUnavailableError:
    return DatabaseUnavailableError(message)


def _exception_summary(exc: BaseException, limit: int = 700) -> str:
    """Flatten task-group wrappers into a useful, safe error summary."""
    leaves: list[str] = []

    def collect(item: BaseException) -> None:
        if isinstance(item, BaseExceptionGroup):
            for child in item.exceptions:
                collect(child)
            return
        if type(item).__name__ in {"CancelledError", "Cancelled"}:
            return
        message = str(item).strip()
        summary = f"{type(item).__name__}: {message}" if message else type(item).__name__
        if summary not in leaves:
            leaves.append(summary)

    collect(exc)
    summary = "; ".join(leaves) or f"{type(exc).__name__}: {str(exc).strip()}"
    return summary[:limit]


def _mcp_error_result_summary(payload: dict[str, Any]) -> str:
    texts = [
        str(item.get("text", "")).strip()
        for item in payload.get("content", [])
        if isinstance(item, dict) and item.get("type") == "text" and item.get("text")
    ]
    if texts:
        return "; ".join(texts)[:700]
    structured = payload.get("structured_content") or payload.get("structuredContent")
    if structured is not None:
        return json.dumps(structured, default=str)[:700]
    return "MCP server returned an error result"


def list_sources() -> list[dict[str, Any]]:
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT s.*, COUNT(d.tool_definition_id) AS tool_count "
                    "FROM tool_sources s LEFT JOIN tool_definitions d ON d.source_id=s.source_id AND d.isActive='Y' "
                    "WHERE s.isActive='Y' GROUP BY s.source_id ORDER BY s.last_updated_at DESC"
                )
                return cursor.fetchall()
    except Error as exc:
        raise _database_error("Tool source lookup failed", exc) from exc


def list_tools(*, search: str = "", connection: str | None = None, category: str | None = None,
               effect: str | None = None, status: str | None = None, source_id: str | None = None) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    clauses.extend(["d.isActive = 'Y'", "s.isActive = 'Y'"])
    if search:
        clauses.append("(d.display_name LIKE %s OR d.description LIKE %s OR d.external_name LIKE %s)")
        params.extend([f"%{search}%"] * 3)
    for column, value in (("connection_type", connection), ("category", category), ("effect", effect),
                          ("status", status), ("source_id", source_id)):
        if value:
            clauses.append(f"d.{column} = %s")
            params.append(value)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    try:
        with closing(get_connection_pool().get_connection()) as connection_obj:
            with closing(connection_obj.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT d.*, s.name AS source_name, s.owner_email, s.endpoint "
                    "FROM tool_definitions d JOIN tool_sources s ON s.source_id=d.source_id" + where +
                    " ORDER BY d.display_name", params
                )
                return [_decode(row) for row in cursor.fetchall()]
    except Error as exc:
        raise _database_error("Tool lookup failed", exc) from exc


def get_tool(tool_definition_id: str) -> dict[str, Any] | None:
    tools = _select_tools("d.tool_definition_id = %s", [tool_definition_id])
    return tools[0] if tools else None


def get_tools_by_ids(tool_definition_ids: list[str]) -> list[dict[str, Any]]:
    if not tool_definition_ids:
        return []
    placeholders = ",".join(["%s"] * len(tool_definition_ids))
    return _select_tools(f"d.tool_definition_id IN ({placeholders})", tool_definition_ids)


def list_executions(*, tool_definition_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    where = " WHERE e.tool_definition_id = %s" if tool_definition_id else ""
    params: list[Any] = [tool_definition_id] if tool_definition_id else []
    params.append(limit)
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT e.*, d.display_name AS tool_name FROM tool_executions e "
                    "JOIN tool_definitions d ON d.tool_definition_id=e.tool_definition_id" + where +
                    " ORDER BY e.created_at DESC LIMIT %s",
                    params,
                )
                rows = cursor.fetchall()
                for row in rows:
                    for field in ("input_payload", "output_payload"):
                        if isinstance(row.get(field), str):
                            row[field] = json.loads(row[field])
                return rows
    except Error as exc:
        raise _database_error("Tool execution lookup failed", exc) from exc


def _select_tools(where: str, params: list[Any]) -> list[dict[str, Any]]:
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT d.*, s.name AS source_name, s.owner_email, s.endpoint, s.status AS source_status "
                    "FROM tool_definitions d JOIN tool_sources s ON s.source_id=d.source_id "
                    "WHERE d.isActive='Y' AND s.isActive='Y' AND (" + where + ")",
                    params,
                )
                return [_decode(row) for row in cursor.fetchall()]
    except Error as exc:
        raise _database_error("Tool lookup failed", exc) from exc


def deactivate_tool(tool_definition_id: str) -> bool:
    """Soft-delete one active tool definition."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "UPDATE tool_definitions SET isActive='N' WHERE tool_definition_id=%s AND isActive='Y'",
                    (tool_definition_id,),
                )
                deactivated = cursor.rowcount > 0
                if deactivated:
                    cursor.execute(
                        "UPDATE agents a JOIN agent_tool_bindings b ON b.agent_id=a.agent_id "
                        "SET a.last_updated_at=UTC_TIMESTAMP(6) WHERE b.tool_definition_id=%s",
                        (tool_definition_id,),
                    )
            connection.commit()
        return deactivated
    except Error as exc:
        raise _database_error("Tool deactivation failed", exc) from exc


def deactivate_source(source_id: str) -> bool:
    """Soft-delete an MCP source and all of its discovered tools atomically."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "UPDATE tool_sources SET isActive='N' WHERE source_id=%s AND source_type='mcp' AND isActive='Y'",
                    (source_id,),
                )
                deactivated = cursor.rowcount > 0
                if deactivated:
                    cursor.execute(
                        "UPDATE tool_definitions SET isActive='N' WHERE source_id=%s AND isActive='Y'",
                        (source_id,),
                    )
                    cursor.execute(
                        "UPDATE agents a JOIN agent_tool_bindings b ON b.agent_id=a.agent_id "
                        "JOIN tool_definitions d ON d.tool_definition_id=b.tool_definition_id "
                        "SET a.last_updated_at=UTC_TIMESTAMP(6) WHERE d.source_id=%s",
                        (source_id,),
                    )
            connection.commit()
        return deactivated
    except Error as exc:
        raise _database_error("Tool source deactivation failed", exc) from exc


def create_source(values: dict[str, Any]) -> dict[str, Any]:
    source_id = str(uuid4())
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "INSERT INTO tool_sources (source_id,source_type,name,description,endpoint,transport,owner_email,status) "
                    "VALUES (%s,'mcp',%s,%s,%s,'streamable_http',%s,'unavailable')",
                    (source_id, values["name"], values.get("description"), values["endpoint"], values["owner_email"]),
                )
            connection.commit()
    except Error as exc:
        raise _database_error("Tool source creation failed", exc) from exc
    return {"source_id": source_id, **values, "source_type": "mcp", "transport": "streamable_http", "status": "unavailable", "tool_count": 0}


def update_source(source_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
    """Update editable metadata for one active MCP source."""
    existing = _get_source(source_id)
    if existing is None or existing.get("source_type") != "mcp":
        return None
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "UPDATE tool_sources SET name=%s,description=%s,endpoint=%s "
                    "WHERE source_id=%s AND source_type='mcp' AND isActive='Y'",
                    (values["name"], values.get("description"), values["endpoint"], source_id),
                )
            connection.commit()
    except Error as exc:
        raise _database_error("Tool source update failed", exc) from exc
    return _get_source(source_id)


def create_custom_tool(values: dict[str, Any]) -> dict[str, Any]:
    record = {"name": values["name"], "description": values["description"], "source_code": values["source_code"], "enabled": True}
    validate_tool_definitions([record])
    tool = build_langchain_tools([record])[0]
    schema = tool.args_schema.model_json_schema() if tool.args_schema else {"type": "object", "properties": {}}
    source_id, tool_id = str(uuid4()), str(uuid4())
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "INSERT INTO tool_sources (source_id,source_type,name,description,owner_email,status,last_checked_at) "
                    "VALUES (%s,'custom',%s,%s,%s,'available',UTC_TIMESTAMP(6))",
                    (source_id, f"{values['name']} package", values.get("source_description"), values["owner_email"]),
                )
                cursor.execute(
                    "INSERT INTO tool_definitions (tool_definition_id,source_id,external_name,display_name,description,"
                    "connection_type,input_schema,category,effect,effect_source,status,examples,output_preview,source_code) "
                    "VALUES (%s,%s,%s,%s,%s,'custom_langchain',%s,%s,%s,'user_declared','available',%s,%s,%s)",
                    (tool_id, source_id, values["name"], values.get("display_name") or values["name"], values["description"],
                     json.dumps(schema), values.get("category", "Other"), values.get("effect", "unknown"),
                     json.dumps(values.get("examples", [])), json.dumps(values.get("output_preview")), values["source_code"]),
                )
            connection.commit()
    except Error as exc:
        raise _database_error("Custom tool creation failed", exc) from exc
    return get_tool(tool_id) or {}


async def discover_source(source_id: str) -> dict[str, Any]:
    source = _get_source(source_id)
    if source is None:
        raise KeyError(source_id)
    started = time.monotonic()
    try:
        result = await list_mcp_tools(source["endpoint"], refresh=True)
        discovered = [tool.model_dump(mode="json", by_alias=True) for tool in result.tools]
        _save_discovery(source_id, discovered, None)
        status = "available"
        error = None
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:700]}"
        _save_discovery(source_id, [], error, mark_missing=False)
        status = "unavailable"
        discovered = []
    return {"source_id": source_id, "status": status, "tool_count": len(discovered), "error": error,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def _get_source(source_id: str) -> dict[str, Any] | None:
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute("SELECT * FROM tool_sources WHERE source_id=%s AND isActive='Y'", (source_id,))
                return cursor.fetchone()
    except Error as exc:
        raise _database_error("Tool source lookup failed", exc) from exc


def _save_discovery(source_id: str, tools: list[dict[str, Any]], error: str | None, *, mark_missing: bool = True) -> None:
    names = [tool["name"] for tool in tools]
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "UPDATE tool_sources SET status=%s,last_error=%s,last_checked_at=UTC_TIMESTAMP(6) WHERE source_id=%s",
                    ("available" if error is None else "unavailable", error, source_id),
                )
                if mark_missing:
                    if names:
                        placeholders = ",".join(["%s"] * len(names))
                        cursor.execute(f"UPDATE tool_definitions SET status='unavailable' WHERE source_id=%s AND external_name NOT IN ({placeholders})", [source_id, *names])
                    else:
                        cursor.execute("UPDATE tool_definitions SET status='unavailable' WHERE source_id=%s", (source_id,))
                for item in tools:
                    annotations = item.get("annotations") or {}
                    effect = "read" if annotations.get("readOnlyHint") else "delete" if annotations.get("destructiveHint") else "unknown"
                    input_schema = item.get("inputSchema") or item.get("input_schema") or {}
                    output_schema = item.get("outputSchema") if "outputSchema" in item else item.get("output_schema")
                    cursor.execute(
                        "INSERT INTO tool_definitions (tool_definition_id,source_id,external_name,display_name,description,connection_type,input_schema,output_schema,category,effect,effect_source,status) "
                        "VALUES (%s,%s,%s,%s,%s,'mcp',%s,%s,'Other',%s,%s,'available') "
                        "ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),description=VALUES(description),input_schema=VALUES(input_schema),output_schema=VALUES(output_schema),effect=VALUES(effect),effect_source=VALUES(effect_source),status='available'",
                        (str(uuid4()), source_id, item["name"], item.get("title") or item["name"], item.get("description") or "No description provided.",
                         json.dumps(input_schema), json.dumps(output_schema), effect,
                         "provider_declared" if effect != "unknown" else "unknown"),
                    )
            connection.commit()
    except Error as exc:
        raise _database_error("Tool discovery save failed", exc) from exc


async def test_tool(tool_definition_id: str, arguments: dict[str, Any], invoked_by: str) -> dict[str, Any]:
    definition = get_tool(tool_definition_id)
    if definition is None:
        raise KeyError(tool_definition_id)
    started = time.monotonic()
    outcome, error, output = "success", None, None
    try:
        if definition["connection_type"] == "mcp":
            result = await call_mcp_tool(definition["endpoint"], definition["external_name"], arguments)
            output = result.model_dump(mode="json")
            if result.is_error:
                outcome, error = "error", _mcp_error_result_summary(output)
        else:
            record = {"name": definition["external_name"], "description": definition["description"], "source_code": definition["source_code"], "enabled": True}
            output = build_langchain_tools([record])[0].invoke(arguments)
    except Exception as exc:
        logger.exception("Tool execution failed for %s", tool_definition_id)
        outcome, error, output = "error", _exception_summary(exc), None
    duration = int((time.monotonic() - started) * 1000)
    serialized_output = json.dumps(output, default=str) if output is not None else None
    safe_output = (
        json.loads(serialized_output)
        if serialized_output is not None and len(serialized_output) <= 20000
        else {"truncated": True, "preview": (serialized_output or "")[:19000]}
        if serialized_output is not None
        else None
    )
    execution_id = str(uuid4())
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "INSERT INTO tool_executions (execution_id,tool_definition_id,input_payload,output_payload,outcome,error_summary,duration_ms,invoked_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (execution_id, tool_definition_id, json.dumps(arguments), json.dumps(safe_output), outcome, error, duration, invoked_by),
                )
            connection.commit()
    except Error as exc:
        raise _database_error("Tool execution audit failed", exc) from exc
    return {"execution_id": execution_id, "outcome": outcome, "output": safe_output, "error": error, "duration_ms": duration}


async def test_inline_tool(name: str, description: str, source_code: str,
                           arguments: dict[str, Any]) -> dict[str, Any]:
    """Execute an unsaved inline Python tool without persisting an audit record."""
    started = time.monotonic()
    outcome, error, output = "success", None, None
    record = {
        "name": name,
        "description": description,
        "source_code": source_code,
        "enabled": True,
        "connection_type": "custom_langchain",
    }
    try:
        validate_tool_definitions([record])
        output = build_langchain_tools([record])[0].invoke(arguments)
    except Exception as exc:
        logger.exception("Inline tool preview failed for %s", name)
        outcome, error, output = "error", _exception_summary(exc), None
    duration = int((time.monotonic() - started) * 1000)
    serialized_output = json.dumps(output, default=str) if output is not None else None
    safe_output = (
        json.loads(serialized_output)
        if serialized_output is not None and len(serialized_output) <= 20000
        else {"truncated": True, "preview": (serialized_output or "")[:19000]}
        if serialized_output is not None
        else None
    )
    return {"outcome": outcome, "output": safe_output, "error": error, "duration_ms": duration}
