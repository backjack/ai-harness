"""In-process event collection for one streaming chat execution."""

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


class ChatEventSink:
    """Assign ordered event IDs and make execution events available to SSE."""

    def __init__(self) -> None:
        self.chat_event_id = str(uuid4())
        self._sequence = 0
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    def emit(self, event_type: str, **payload: Any) -> None:
        self._sequence += 1
        self.queue.put_nowait(
            {
                "chat_event_id": self.chat_event_id,
                "event_id": self._sequence,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": event_type,
                **payload,
            }
        )

    def __call__(self, event: dict[str, Any]) -> None:
        """Accept a complete LangChain trace record."""
        payload = dict(event)
        event_type = str(payload.pop("event", "langchain.event"))
        promoted = {
            key: payload[key]
            for key in ("tool_name", "tool_call_id", "arguments", "result", "duration_ms", "error", "error_type")
            if key in payload
        }
        serialized = payload.get("serialized")
        if "tool_name" not in promoted and isinstance(serialized, dict) and isinstance(serialized.get("name"), str):
            promoted["tool_name"] = serialized["name"]
        if event_type == "langchain.tool.start" and "arguments" not in promoted and "input" in payload:
            promoted["arguments"] = payload["input"]
        if event_type == "langchain.tool.end" and "result" not in promoted and "output" in payload:
            promoted["result"] = payload["output"]
        self.emit(event_type, **promoted, payload=payload)
