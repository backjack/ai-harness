"""CRUD endpoints for agent definitions."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from utils.database import DatabaseUnavailableError
from services.agent_repository import create_agent, deactivate_agent, get_agent, list_agents, update_agent
from services.tool_runtime import ToolFunctionValidationError, validate_tool_definitions


router = APIRouter(prefix="/agents", tags=["agents"])


class AgentTool(BaseModel):
    """Trusted Python tool configuration owned by one agent."""

    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=255)
    description: str = Field(min_length=1, max_length=2000)
    source_code: str = ""
    enabled: bool = True
    connection_type: Literal["custom_langchain", "mcp"] = "custom_langchain"
    tool_definition_id: str | None = None
    source_id: str | None = None
    version: str | None = None
    category: str = "Other"
    effect: Literal["read", "calculate", "write", "delete", "unknown"] = "unknown"
    effect_source: str = "unknown"
    input_schema: dict[str, Any] = Field(default_factory=dict)
    approval_policy: Literal["automatic", "ask", "disabled"] = "automatic"
    allowed_scope: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=dict)


class AgentBase(BaseModel):
    agent_name: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=4000)
    initiative_id: str | None = Field(default=None, max_length=255)
    owner_email: str = Field(min_length=3, max_length=320)
    shared_with: list[str] = Field(default_factory=list)
    model_id: str = Field(min_length=1, max_length=255)
    tooling: list[AgentTool] = Field(default_factory=list)
    system_prompts: list[str] = Field(default_factory=list)
    user_prompts: list[str] = Field(default_factory=list)
    model_type: Literal["openai", "ollama"] = Field(
        description="Model provider. Use 'openai' or 'ollama'; put the model name in model_id."
    )
    guardrails: dict[str, Any] = Field(default_factory=dict)


class AgentCreate(AgentBase):
    faq: dict[str, str] | None = None
    created_by: str = Field(min_length=3, max_length=320)

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_name": "Assistant",
                "owner_email": "owner@example.com",
                "shared_with": [],
                "model_id": "gpt-5.4-mini",
                "tooling": [
                    {
                        "name": "getMarketPrice",
                        "description": "Return a live stock quote from Yahoo Finance's chart API.",
                        "source_code": "def getMarketPrice(stock_symbol: str) -> dict[str, object]: ...",
                        "enabled": True,
                    }
                ],
                "system_prompts": [],
                "user_prompts": [],
                "model_type": "openai",
                "guardrails": {},
                "created_by": "owner@example.com",
            }
        }
    )


class AgentUpdate(BaseModel):
    agent_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    initiative_id: str | None = Field(default=None, max_length=255)
    faq: dict[str, str] | None = None
    owner_email: str | None = Field(default=None, min_length=3, max_length=320)
    shared_with: list[str] | None = None
    model_id: str | None = Field(default=None, min_length=1, max_length=255)
    tooling: list[AgentTool] | None = None
    system_prompts: list[str] | None = None
    user_prompts: list[str] | None = None
    model_type: Literal["openai", "ollama"] | None = None
    guardrails: dict[str, Any] | None = None


class AgentResponse(AgentBase):
    agent_id: str
    created_by: str
    created_at: datetime
    last_updated_at: datetime


class AgentDetailResponse(AgentResponse):
    faq: dict[str, str] = Field(default_factory=dict)


def _database_error(exc: DatabaseUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Database service is unavailable",
    )


@router.post("", response_model=AgentDetailResponse, status_code=status.HTTP_201_CREATED)
async def create_agent_endpoint(request: AgentCreate) -> dict[str, Any]:
    """Create an agent definition."""
    try:
        return create_agent(request.model_dump())
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc
    except ToolFunctionValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.get("", response_model=list[AgentResponse])
async def list_agents_endpoint() -> list[dict[str, Any]]:
    """List agent definitions."""
    try:
        return list_agents()
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc


@router.get("/{agent_id}", response_model=AgentDetailResponse)
async def get_agent_endpoint(agent_id: str) -> dict[str, Any]:
    """Get one agent definition."""
    try:
        agent = get_agent(agent_id)
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return agent


@router.patch("/{agent_id}", response_model=AgentDetailResponse)
async def update_agent_endpoint(agent_id: str, request: AgentUpdate) -> dict[str, Any]:
    """Partially update an agent definition."""
    try:
        agent = update_agent(agent_id, request.model_dump(exclude_unset=True))
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return agent


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_endpoint(agent_id: str) -> None:
    """Soft-delete an agent definition."""
    try:
        deleted = deactivate_agent(agent_id)
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
