"""Parameterized MySQL persistence for agents and successful chats."""

from contextlib import closing
import json
import logging
from typing import Any
from uuid import uuid4

from mysql.connector import Error, IntegrityError

from utils.database import DatabaseUnavailableError, get_connection_pool
from services.tool_runtime import ToolFunctionValidationError, validate_tool_definitions


logger = logging.getLogger("ai_harness.agent_repository")

JSON_COLUMNS = {"shared_with", "tooling", "system_prompts", "user_prompts", "guardrails", "faq"}
TOOL_REQUIRED_STRING_FIELDS = ("name", "description")
AGENT_COLUMNS = {
    "agent_name",
    "description",
    "initiative_id",
    "faq",
    "owner_email",
    "shared_with",
    "model_id",
    "tooling",
    "system_prompts",
    "user_prompts",
    "model_type",
    "guardrails",
    "created_by",
}


def _decode_agent(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    for column in JSON_COLUMNS:
        value = row.get(column)
        if isinstance(value, str):
            try:
                row[column] = json.loads(value)
            except json.JSONDecodeError:
                if column == "tooling":
                    logger.warning(
                        "Ignoring malformed persisted tooling JSON agent_id=%s",
                        row.get("agent_id"),
                    )
                    row[column] = []
                else:
                    raise
    row["tooling"] = _normalize_tooling(row.get("tooling"), row.get("agent_id"))
    row["faq"] = _normalize_faq(row.get("faq"), row.get("agent_id"))
    if row.get("description") is None:
        row["description"] = ""
    return row


def _normalize_tooling(value: Any, agent_id: Any) -> list[dict[str, Any]]:
    """Return only persisted tool objects that can satisfy the public agent schema."""
    if not isinstance(value, list):
        logger.warning("Ignoring non-list persisted tooling agent_id=%s", agent_id)
        return []

    tools: list[dict[str, Any]] = []
    invalid_entries = 0
    for item in value:
        if not isinstance(item, dict) or not all(
            isinstance(item.get(field), str) and item[field].strip()
            for field in TOOL_REQUIRED_STRING_FIELDS
        ):
            invalid_entries += 1
            continue
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            invalid_entries += 1
            continue
        normalized = dict(item)
        normalized["enabled"] = enabled
        normalized.setdefault("connection_type", "custom_langchain")
        normalized.setdefault("source_code", "")
        if normalized["connection_type"] != "mcp" and not normalized["source_code"].strip():
            invalid_entries += 1
            continue
        tools.append(normalized)

    if invalid_entries:
        logger.warning(
            "Ignoring %s invalid persisted tooling entries agent_id=%s",
            invalid_entries,
            agent_id,
        )
    return tools


def _normalize_faq(value: Any, agent_id: Any) -> dict[str, str]:
    """Return a persisted FAQ that satisfies the public question-answer schema."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        logger.warning("Ignoring non-object persisted FAQ agent_id=%s", agent_id)
        return {}

    faq = {
        question: answer
        for question, answer in value.items()
        if isinstance(question, str) and isinstance(answer, str)
    }
    if len(faq) != len(value):
        logger.warning("Ignoring invalid persisted FAQ entries agent_id=%s", agent_id)
    return faq


def _serialize_agent_values(values: dict[str, Any]) -> dict[str, Any]:
    return {
        key: (
            None
            if key == "faq" and value is None
            else json.dumps(value) if key in JSON_COLUMNS else value
        )
        for key, value in values.items()
    }


def create_agent(values: dict[str, Any]) -> dict[str, Any]:
    """Insert an agent and return its persisted representation."""
    validate_tool_definitions(values.get("tooling", []))
    agent_id = str(uuid4())
    serialized = _serialize_agent_values(values)
    columns = ["agent_id", *serialized.keys()]
    placeholders = ", ".join(["%s"] * len(columns))
    query = f"INSERT INTO agents ({', '.join(columns)}) VALUES ({placeholders})"

    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(query, [agent_id, *serialized.values()])
                _sync_agent_tool_bindings(cursor, agent_id, values.get("tooling", []))
            connection.commit()
    except Error as exc:
        logger.exception("Agent creation failed")
        raise DatabaseUnavailableError("Agent creation failed") from exc

    return get_agent(agent_id) or {}


def get_agent(agent_id: str) -> dict[str, Any] | None:
    """Return one agent by identifier."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute("SELECT * FROM agents WHERE agent_id = %s AND isActive = 'Y'", (agent_id,))
                return _decode_agent(cursor.fetchone())
    except Error as exc:
        logger.exception("Agent lookup failed")
        raise DatabaseUnavailableError("Agent lookup failed") from exc


def list_agents() -> list[dict[str, Any]]:
    """Return all agents ordered by their latest update."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute("SELECT * FROM agents WHERE isActive = 'Y' ORDER BY last_updated_at DESC")
                return [_decode_agent(row) or {} for row in cursor.fetchall()]
    except Error as exc:
        logger.exception("Agent list lookup failed")
        raise DatabaseUnavailableError("Agent list lookup failed") from exc


def update_agent(agent_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
    """Apply a partial update to an existing agent."""
    existing = get_agent(agent_id)
    if existing is None or not values:
        return existing
    validate_tool_definitions(values.get("tooling", existing["tooling"]))

    serialized = _serialize_agent_values(values)
    assignments = ", ".join(f"{column} = %s" for column in serialized)
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "SELECT 1 FROM agents WHERE agent_id = %s AND isActive = 'Y' FOR UPDATE",
                    (agent_id,),
                )
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    f"UPDATE agents SET {assignments} WHERE agent_id = %s AND isActive = 'Y'",
                    [*serialized.values(), agent_id],
                )
                if "tooling" in values:
                    _sync_agent_tool_bindings(cursor, agent_id, values["tooling"])
            connection.commit()
    except Error as exc:
        logger.exception("Agent update failed")
        raise DatabaseUnavailableError("Agent update failed") from exc

    return get_agent(agent_id)


def deactivate_agent(agent_id: str) -> bool:
    """Soft-delete an active agent while retaining its history."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "UPDATE agents SET isActive = 'N' WHERE agent_id = %s AND isActive = 'Y'",
                    (agent_id,),
                )
                deactivated = cursor.rowcount > 0
            connection.commit()
        return deactivated
    except Error as exc:
        logger.exception("Agent deactivation failed")
        raise DatabaseUnavailableError("Agent deactivation failed") from exc


def _sync_agent_tool_bindings(cursor: Any, agent_id: str, tooling: list[dict[str, Any]]) -> None:
    """Mirror library snapshots into the normalized binding table."""
    cursor.execute("DELETE FROM agent_tool_bindings WHERE agent_id = %s", (agent_id,))
    for tool in tooling:
        tool_definition_id = tool.get("tool_definition_id")
        if not tool_definition_id:
            continue
        cursor.execute(
            "INSERT INTO agent_tool_bindings (binding_id,agent_id,tool_definition_id,approval_policy,allowed_scope,defaults,enabled,snapshot_version) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (str(uuid4()), agent_id, tool_definition_id, tool.get("approval_policy", "automatic"),
             json.dumps(tool.get("allowed_scope") or {}), json.dumps(tool.get("defaults") or {}),
             bool(tool.get("enabled", True)), tool.get("version")),
        )


def get_session_history(
    agent_id: str, session_id: str, interaction_limit: int
) -> list[dict[str, str]]:
    """Return the latest successful chat turns in chronological order."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT input_payload, output_payload FROM agent_chat_interactions "
                    "WHERE agent_id = %s AND session_id = %s "
                    "ORDER BY chat_sequence_id DESC LIMIT %s",
                    (agent_id, session_id, interaction_limit),
                )
                rows = cursor.fetchall()
    except Error as exc:
        logger.exception("Chat history lookup failed")
        raise DatabaseUnavailableError("Chat history lookup failed") from exc

    turns: list[dict[str, str]] = []
    for row in reversed(rows):
        input_payload = row["input_payload"]
        output_payload = row["output_payload"]
        if isinstance(input_payload, str):
            input_payload = json.loads(input_payload)
        if isinstance(output_payload, str):
            output_payload = json.loads(output_payload)
        user_prompt = input_payload.get("user_prompt") if isinstance(input_payload, dict) else None
        response = output_payload.get("response") if isinstance(output_payload, dict) else None
        if isinstance(user_prompt, str) and isinstance(response, str):
            turns.append({"user_prompt": user_prompt, "response": response})
    return turns


def get_analytics_usage(*, lookback_days: int) -> dict[str, list[dict[str, Any]]]:
    """Aggregate recent successful chat usage by model and agent/model."""
    base_query = (
        " FROM agent_chat_interactions aci "
        "WHERE aci.created_at >= UTC_TIMESTAMP(6) - INTERVAL %s DAY "
    )
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT aci.model_id, COUNT(*) AS interaction_count, "
                    "COALESCE(SUM(aci.input_token_count), 0) AS input_tokens, "
                    "COALESCE(SUM(aci.output_token_count), 0) AS output_tokens"
                    + base_query
                    + "GROUP BY aci.model_id ORDER BY aci.model_id",
                    (lookback_days,),
                )
                by_model = cursor.fetchall()
                cursor.execute(
                    "SELECT aci.agent_id, agents.agent_name, aci.model_id, "
                    "COUNT(*) AS interaction_count, "
                    "COALESCE(SUM(aci.input_token_count), 0) AS input_tokens, "
                    "COALESCE(SUM(aci.output_token_count), 0) AS output_tokens "
                    "FROM agent_chat_interactions aci "
                    "LEFT JOIN agents ON agents.agent_id = aci.agent_id "
                    "WHERE aci.created_at >= UTC_TIMESTAMP(6) - INTERVAL %s DAY "
                    "GROUP BY aci.agent_id, agents.agent_name, aci.model_id "
                    "ORDER BY agents.agent_name, aci.agent_id, aci.model_id",
                    (lookback_days,),
                )
                by_agent = cursor.fetchall()
    except Error as exc:
        logger.exception("Analytics usage lookup failed")
        raise DatabaseUnavailableError("Analytics usage lookup failed") from exc

    return {"by_model": by_model, "by_agent": by_agent}


def record_successful_chat(
    *,
    agent_id: str,
    user_id: str,
    session_id: str,
    model_id: str,
    user_prompt: str,
    response_text: str,
    input_tokens: int,
    output_tokens: int,
    response_message: dict[str, Any] | None = None,
) -> int:
    """Persist a successful interaction and return its per-session sequence."""
    for _ in range(3):
        try:
            with closing(get_connection_pool().get_connection()) as connection:
                with closing(connection.cursor()) as cursor:
                    cursor.execute(
                        "SELECT COALESCE(MAX(chat_sequence_id), 0) + 1 "
                        "FROM agent_chat_interactions "
                        "WHERE agent_id = %s AND session_id = %s",
                        (agent_id, session_id),
                    )
                    chat_sequence_id = int(cursor.fetchone()[0])
                    cursor.execute(
                        "INSERT INTO agent_chat_interactions ("
                        "agent_chat_interaction_id, agent_id, input_payload, output_payload, "
                        "input_token_count, output_token_count, model_id, user_id, session_id, "
                        "chat_sequence_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (
                            str(uuid4()),
                            agent_id,
                            json.dumps({"user_prompt": user_prompt}),
                            json.dumps({
                                "response": response_text,
                                **({"message": response_message} if response_message else {}),
                            }),
                            input_tokens,
                            output_tokens,
                            model_id,
                            user_id,
                            session_id,
                            chat_sequence_id,
                        ),
                    )
                connection.commit()
                return chat_sequence_id
        except IntegrityError:
            logger.warning("Chat sequence collision; retrying interaction audit insert")
        except Error as exc:
            logger.exception("Successful chat audit insert failed")
            raise DatabaseUnavailableError("Chat audit insert failed") from exc

    raise DatabaseUnavailableError("Chat audit sequence allocation failed")
