"""Read-only usage analytics endpoints."""

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from services.analytics import get_analytics_report
from utils.database import DatabaseUnavailableError


router = APIRouter(prefix="/analytics", tags=["analytics"])


class CostMetrics(BaseModel):
    interaction_count: int
    input_tokens: int
    output_tokens: int
    cost_status: Literal["available", "partial", "unavailable"]
    input_cost_usd: float | None
    output_cost_usd: float | None
    cost_usd: float | None


class ModelAnalytics(CostMetrics):
    model_id: str


class AgentAnalytics(CostMetrics):
    agent_id: str
    agent_name: str | None


class DailyModelAnalytics(ModelAnalytics):
    date: str


class AnalyticsReport(BaseModel):
    lookback_days: int
    summary: CostMetrics
    by_model: list[ModelAnalytics]
    by_agent: list[AgentAnalytics]
    daily_by_model: list[DailyModelAnalytics]


@router.get("", response_model=AnalyticsReport)
async def get_analytics() -> dict:
    """Report successful-chat token usage and estimated cost from the last 30 days."""
    try:
        return get_analytics_report()
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc
