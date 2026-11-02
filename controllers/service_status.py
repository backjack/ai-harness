"""Controllers for service identification, health, and chat."""

import asyncio
import json
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from utils.database import (
    DatabaseConfigurationError,
    DatabaseUnavailableError,
    check_database_readiness,
)
from services.agent_repository import get_agent, record_successful_chat
from services.chat_message import classify_message_payload, json_safe
from services.conversation_agent import conversation_agent_cache
from services.chat_events import ChatEventSink
from services.model_execution import (
    ModelExecutionError,
    ModelNotConfiguredError,
)
from services.service_status import get_health_status, get_service_identifier
from services.auth import AuthenticatedUser, CurrentUser


router = APIRouter()


class ChatRequest(BaseModel):
    """A chat request associated with an agent and optional session."""

    agent_id: str = Field(min_length=1, max_length=36)
    user_prompt: Annotated[str, Field(min_length=1)]
    session_id: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("user_prompt")
    @classmethod
    def prompt_must_not_be_blank(cls, value: str) -> str:
        """Reject whitespace-only prompts."""
        if not value.strip():
            raise ValueError("prompt must not be blank")
        return value


class ChatResponse(BaseModel):
    """The audited final message and selected LangChain response attributes."""

    chat_event_id: str
    response: "ChatMessage"
    model_response: dict[str, Any]
    session_id: str
    chat_sequence_id: int


class ChatMessage(BaseModel):
    """Classified final model content."""

    type: Literal["markdown", "json", "html", "tool", "chart"]
    content: Any


def _json_safe(value: Any) -> Any:
    return json_safe(value)


def _classify_message(response_text: str, attributes: dict[str, Any]) -> ChatMessage:
    return ChatMessage(**classify_message_payload(response_text, attributes))


def _emit(event_sink: ChatEventSink | None, event_type: str, **payload: Any) -> None:
    if event_sink is not None:
        event_sink.emit(event_type, **payload)


@router.get("/", tags=["service"])
async def root() -> dict[str, str]:
    """Identify the service."""
    return get_service_identifier()


@router.get("/health", tags=["health"])
async def health_check() -> dict[str, str]:
    """Report that the service is available."""
    return get_health_status()


@router.get("/health/database", tags=["health"])
async def database_health_check() -> dict[str, str]:
    """Report whether the configured MySQL database is reachable."""
    try:
        check_database_readiness()
    except DatabaseConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is not configured",
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc

    return {"status": "ok"}


async def _run_chat(
    request: ChatRequest,
    user: AuthenticatedUser,
    event_sink: ChatEventSink | None = None,
) -> ChatResponse:
    """Generate and audit a response for a configured agent."""
    chat_event_id = event_sink.chat_event_id if event_sink else str(uuid4())
    _emit(event_sink, "agent.lookup.start", agent_id=request.agent_id)
    try:
        agent = get_agent(request.agent_id)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc

    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    _emit(event_sink, "agent.lookup.end", agent=agent)

    session_id = request.session_id or str(uuid4())
    _emit(event_sink, "session.initialized", session_id=session_id)
    try:
        runtime_agent = await conversation_agent_cache.get_or_create(agent, session_id)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc
    except ModelNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Chat service is not configured",
        ) from exc
    except ModelExecutionError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Chat service is temporarily unavailable",
        ) from exc

    async with runtime_agent.lock:
        _emit(event_sink, "agent.execution.start", session_id=session_id)
        try:
            response = await runtime_agent.execute(request.user_prompt, event_sink)
        except ModelNotConfiguredError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Chat service is not configured",
            ) from exc
        except ModelExecutionError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Chat service is temporarily unavailable",
            ) from exc

        classified_message = _classify_message(response.text, response.attributes)
        try:
            chat_sequence_id = record_successful_chat(
                agent_id=request.agent_id,
                user_id=user.email,
                session_id=session_id,
                model_id=agent["model_id"],
                user_prompt=request.user_prompt,
                response_text=response.text,
                response_message=classified_message.model_dump(),
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
            )
        except DatabaseUnavailableError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Database service is unavailable",
            ) from exc

        runtime_agent.add_successful_turn(request.user_prompt, response.text)
        _emit(
            event_sink,
            "chat.audit.success",
            session_id=session_id,
            chat_sequence_id=chat_sequence_id,
        )

    return ChatResponse(
        chat_event_id=chat_event_id,
        response=classified_message,
        model_response=_json_safe(response.attributes),
        session_id=session_id,
        chat_sequence_id=chat_sequence_id,
    )


@router.post(
    "/chat",
    tags=["chat"],
    response_model=ChatResponse,
    responses={
        404: {"description": "The requested agent does not exist."},
        502: {"description": "The configured model provider could not complete the request."},
        503: {"description": "The chat or database service is unavailable."},
    },
)
async def chat(request: ChatRequest, user: CurrentUser) -> ChatResponse:
    """Generate, audit, and return a rich final response."""
    return await _run_chat(request, user)


def _sse_frame(event: dict[str, Any]) -> str:
    return (
        f"id: {event['event_id']}\n"
        f"event: {event['type']}\n"
        f"data: {json.dumps(event, default=str)}\n\n"
    )


@router.post(
    "/chat/stream",
    tags=["chat"],
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def chat_stream(request: ChatRequest, user: CurrentUser) -> StreamingResponse:
    """Stream full model and tool progress until the audited final response."""
    sink = ChatEventSink()

    async def produce() -> None:
        try:
            result = await _run_chat(request, user, sink)
            sink.emit("final", response=result.model_dump())
            sink.emit("complete", session_id=result.session_id)
        except HTTPException as exc:
            sink.emit("error", status_code=exc.status_code, detail=exc.detail)
        except Exception as exc:
            sink.emit("error", status_code=500, detail=str(exc))

    async def event_stream():
        task = asyncio.create_task(produce())
        while not task.done() or not sink.queue.empty():
            event = await sink.queue.get()
            yield _sse_frame(event)
        await task

    return StreamingResponse(event_stream(), media_type="text/event-stream")
