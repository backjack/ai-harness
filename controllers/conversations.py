"""Recent conversation summary endpoints."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, status
from pydantic import BaseModel

from services.conversation_repository import get_conversation_by_email, list_conversations_by_email
from services.auth import CurrentUser
from utils.database import DatabaseUnavailableError


router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationSummary(BaseModel):
    session_id: str
    agent_id: str
    agent_name: str | None
    model_id: str
    title: str
    interaction_count: int
    last_activity_at: datetime


class ConversationResponse(BaseModel):
    type: Literal["markdown", "json", "html", "tool", "chart"]
    content: object


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime
    chat_sequence_id: int
    response: ConversationResponse | None = None


class ConversationDetail(ConversationSummary):
    messages: list[ConversationMessage]


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    user: CurrentUser,
) -> list[dict]:
    """List the five most recent saved conversations for one user email."""
    try:
        return list_conversations_by_email(user.email, limit=5)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc


@router.get("/{session_id}", response_model=ConversationDetail)
async def get_conversation(
    session_id: Annotated[str, Path(min_length=1, max_length=255)],
    user: CurrentUser,
) -> dict:
    """Load the complete transcript for an email-owned conversation."""
    try:
        conversation = get_conversation_by_email(user.email, session_id)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc
    if conversation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found",
        )
    return conversation
