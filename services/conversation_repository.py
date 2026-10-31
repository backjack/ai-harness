"""Persistence queries for recent user conversations."""

from contextlib import closing
import json
import logging
from typing import Any

from mysql.connector import Error

from services.chat_message import classify_message_payload, normalize_stored_message
from utils.database import DatabaseUnavailableError, get_connection_pool


logger = logging.getLogger("ai_harness.conversation_repository")


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def list_conversations_by_email(email_id: str, *, limit: int = 5) -> list[dict[str, Any]]:
    """Return the most recently active conversation summaries for one email."""
    query = (
        "SELECT recent.session_id, recent.agent_id, agents.agent_name, "
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(first_interaction.input_payload, '$.user_prompt')), "
        "'New conversation') AS title, "
        "recent.interaction_count, recent.last_activity_at "
        "FROM ("
        "SELECT session_id, agent_id, COUNT(*) AS interaction_count, "
        "MAX(created_at) AS last_activity_at "
        "FROM agent_chat_interactions WHERE user_id = %s "
        "GROUP BY session_id, agent_id ORDER BY last_activity_at DESC LIMIT %s"
        ") AS recent "
        "JOIN agent_chat_interactions AS first_interaction "
        "ON first_interaction.session_id = recent.session_id "
        "AND first_interaction.agent_id = recent.agent_id "
        "AND first_interaction.chat_sequence_id = 1 "
        "LEFT JOIN agents ON agents.agent_id = recent.agent_id "
        "ORDER BY recent.last_activity_at DESC"
    )
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(query, (email_id, limit))
                return cursor.fetchall()
    except Error as exc:
        logger.exception("Conversation summary lookup failed")
        raise DatabaseUnavailableError("Conversation summary lookup failed") from exc


def get_conversation_by_email(email_id: str, session_id: str) -> dict[str, Any] | None:
    """Return a complete conversation when the session belongs to the email."""
    query = (
        "SELECT interactions.agent_id, agents.agent_name, interactions.input_payload, "
        "interactions.output_payload, interactions.chat_sequence_id, interactions.created_at "
        "FROM agent_chat_interactions AS interactions "
        "LEFT JOIN agents ON agents.agent_id = interactions.agent_id "
        "WHERE interactions.user_id = %s AND interactions.session_id = %s "
        "ORDER BY interactions.chat_sequence_id ASC"
    )
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(query, (email_id, session_id))
                rows = cursor.fetchall()
    except Error as exc:
        logger.exception("Conversation detail lookup failed")
        raise DatabaseUnavailableError("Conversation detail lookup failed") from exc

    if not rows:
        return None

    messages: list[dict[str, Any]] = []
    title = "New conversation"
    for row in rows:
        input_payload = _json_object(row["input_payload"])
        output_payload = _json_object(row["output_payload"])
        user_prompt = input_payload.get("user_prompt")
        response = output_payload.get("response")
        stored_message = normalize_stored_message(output_payload.get("message"))
        sequence = int(row["chat_sequence_id"])
        created_at = row["created_at"]
        if isinstance(user_prompt, str):
            if title == "New conversation" and user_prompt.strip():
                title = user_prompt
            messages.append({
                "role": "user",
                "content": user_prompt,
                "created_at": created_at,
                "chat_sequence_id": sequence,
            })
        if isinstance(response, str):
            messages.append({
                "role": "assistant",
                "content": response,
                "response": stored_message or classify_message_payload(response, {}),
                "created_at": created_at,
                "chat_sequence_id": sequence,
            })

    first = rows[0]
    return {
        "session_id": session_id,
        "agent_id": first["agent_id"],
        "agent_name": first["agent_name"],
        "title": title,
        "interaction_count": len(rows),
        "last_activity_at": rows[-1]["created_at"],
        "messages": messages,
    }
