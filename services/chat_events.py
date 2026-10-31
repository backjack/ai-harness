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
        event_type = str(event.pop("event", "langchain.event"))
        self.emit(event_type, payload=event)
