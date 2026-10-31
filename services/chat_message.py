"""Classification helpers for display-ready assistant messages."""

import json
from typing import Any


MESSAGE_TYPES = {"markdown", "json", "html", "tool", "chart"}


def json_safe(value: Any) -> Any:
    """Return a JSON-compatible representation of an arbitrary value."""
    return json.loads(json.dumps(value, default=str))


def classify_message_payload(
    response_text: str, attributes: dict[str, Any]
) -> dict[str, Any]:
    """Classify model output into the message shape consumed by the UI."""
    if attributes.get("tool_calls"):
        return {"type": "tool", "content": json_safe(attributes["tool_calls"])}
    try:
        parsed_response = json.loads(response_text)
    except (TypeError, json.JSONDecodeError):
        pass
    else:
        if isinstance(parsed_response, dict) and parsed_response.get("type") == "chart":
            content = parsed_response.get("content")
            if (
                isinstance(content, dict)
                and content.get("library") == "highcharts"
                and isinstance(content.get("options"), dict)
            ):
                return {"type": "chart", "content": content}
        return {"type": "json", "content": parsed_response}
    if response_text.lstrip().startswith("<") and response_text.rstrip().endswith(">"):
        return {"type": "html", "content": response_text}
    return {"type": "markdown", "content": response_text}


def normalize_stored_message(value: Any) -> dict[str, Any] | None:
    """Validate the minimal shape of a previously classified message."""
    if not isinstance(value, dict) or value.get("type") not in MESSAGE_TYPES:
        return None
    if "content" not in value:
        return None
    if value["type"] == "chart":
        content = value["content"]
        if not (
            isinstance(content, dict)
            and content.get("library") == "highcharts"
            and isinstance(content.get("options"), dict)
        ):
            return None
    return {"type": value["type"], "content": value["content"]}
