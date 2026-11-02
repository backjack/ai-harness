"""CRUD endpoints for agent definitions."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from utils.database import DatabaseUnavailableError
from services.agent_repository import create_agent, deactivate_agent, get_agent, list_agents, update_agent
from services.tool_runtime import ToolFunctionValidationError, validate_tool_definitions
from services.auth import CurrentUser


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


class GuardrailsConfig(BaseModel):
    """Validated policy configuration enforced for every agent turn."""

    policy_text: str | None = Field(default=None, max_length=8000)
    allowed_topics: list[str] = Field(default_factory=list, max_length=100)
    blocked_topics: list[str] = Field(default_factory=list, max_length=100)
    out_of_scope_response: str | None = Field(default=None, max_length=4000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("policy_text", "out_of_scope_response")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("allowed_topics", "blocked_topics")
    @classmethod
    def normalize_topics(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            topic = value.strip()
            key = topic.casefold()
            if topic and key not in seen:
                normalized.append(topic)
                seen.add(key)
        return normalized

    @model_validator(mode="after")
    def require_policy_for_response(self) -> "GuardrailsConfig":
        has_policy = bool(self.policy_text or self.allowed_topics or self.blocked_topics)
        if self.out_of_scope_response and not has_policy:
            raise ValueError(
                "out_of_scope_response requires policy_text, allowed_topics, or blocked_topics"
            )
        return self


class AgentBase(BaseModel):
    agent_name: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=4000)
    initiative_id: str | None = Field(default=None, max_length=255)
    shared_with: list[str] = Field(default_factory=list)
    model_id: str = Field(min_length=1, max_length=255)
    tooling: list[AgentTool] = Field(default_factory=list)
    system_prompts: list[str] = Field(default_factory=list)
    user_prompts: list[str] = Field(default_factory=list)
    model_type: Literal["openai", "ollama"] = Field(
        description="Model provider. Use 'openai' or 'ollama'; put the model name in model_id."
    )
    guardrails: GuardrailsConfig = Field(default_factory=GuardrailsConfig)


class AgentCreate(AgentBase):
    faq: dict[str, str] | None = None

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {
                "agent_name": "Assistant",
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
            }
        }
    )


class AgentUpdate(BaseModel):
    agent_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    initiative_id: str | None = Field(default=None, max_length=255)
    faq: dict[str, str] | None = None
    shared_with: list[str] | None = None
    model_id: str | None = Field(default=None, min_length=1, max_length=255)
    tooling: list[AgentTool] | None = None
    system_prompts: list[str] | None = None
    user_prompts: list[str] | None = None
    model_type: Literal["openai", "ollama"] | None = None
    guardrails: GuardrailsConfig | None = None

    model_config = ConfigDict(extra="forbid")


class AgentResponse(AgentBase):
    agent_id: str
    owner_email: str
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
async def create_agent_endpoint(request: AgentCreate, user: CurrentUser) -> dict[str, Any]:
    """Create an agent definition."""
    try:
        return create_agent({**request.model_dump(), "owner_email": user.email, "created_by": user.email})
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
