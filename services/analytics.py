"""Usage aggregation and estimated OpenAI token-cost calculations."""

from decimal import Decimal
from typing import Any

from services.agent_repository import get_analytics_usage


LOOKBACK_DAYS = 30
TOKEN_UNIT = Decimal("1000000")
MODEL_RATES_USD_PER_MILLION: dict[str, tuple[Decimal, Decimal]] = {
    "gpt-4.1-mini": (Decimal("0.40"), Decimal("1.60")),
    "gpt-5.4-mini": (Decimal("0.75"), Decimal("4.50")),
    "gpt-5.4-mini-2026-03-17": (Decimal("0.75"), Decimal("4.50")),
    "gpt-5.6-luna": (Decimal("0.20"), Decimal("1.20")),
}


def _costs(model_id: str, input_tokens: int, output_tokens: int) -> dict[str, Any]:
    rates = MODEL_RATES_USD_PER_MILLION.get(model_id)
    if rates is None:
        return {
            "cost_status": "unavailable",
            "input_cost_usd": None,
            "output_cost_usd": None,
            "cost_usd": None,
        }
    input_cost = Decimal(input_tokens) * rates[0] / TOKEN_UNIT
    output_cost = Decimal(output_tokens) * rates[1] / TOKEN_UNIT
    return {
        "cost_status": "available",
        "input_cost_usd": float(input_cost),
        "output_cost_usd": float(output_cost),
        "cost_usd": float(input_cost + output_cost),
    }


def _usage_row(row: dict[str, Any]) -> dict[str, Any]:
    input_tokens = int(row["input_tokens"])
    output_tokens = int(row["output_tokens"])
    result: dict[str, Any] = {
        "model_id": str(row["model_id"]),
        "interaction_count": int(row["interaction_count"]),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    result.update(_costs(result["model_id"], input_tokens, output_tokens))
    return result


def get_analytics_report() -> dict[str, Any]:
    """Return 30-day usage totals grouped by model and by agent/model."""
    usage = get_analytics_usage(lookback_days=LOOKBACK_DAYS)
    by_model = [_usage_row(row) for row in usage["by_model"]]
    daily_by_model: list[dict[str, Any]] = []
    for row in usage.get("daily_by_model", []):
        daily_row = _usage_row(row)
        usage_date = row["usage_date"]
        daily_row["date"] = usage_date.isoformat() if hasattr(usage_date, "isoformat") else str(usage_date)
        daily_by_model.append(daily_row)
    by_agent: list[dict[str, Any]] = []
    agent_totals: dict[str, dict[str, Any]] = {}
    for row in usage["by_agent"]:
        agent_id = str(row["agent_id"])
        total = agent_totals.setdefault(
            agent_id,
            {
                "agent_id": agent_id,
                "agent_name": row.get("agent_name"),
                "interaction_count": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "model_rows": [],
            },
        )
        total["interaction_count"] += int(row["interaction_count"])
        total["input_tokens"] += int(row["input_tokens"])
        total["output_tokens"] += int(row["output_tokens"])
        total["model_rows"].append(_usage_row(row))
    for total in agent_totals.values():
        model_rows = total.pop("model_rows")
        unavailable = any(row["cost_status"] == "unavailable" for row in model_rows)
        has_available = any(row["cost_status"] == "available" for row in model_rows)
        available_cost = sum((row["cost_usd"] or 0.0) for row in model_rows)
        total.update(
            {
                "cost_status": "partial" if unavailable and has_available else (
                    "unavailable" if unavailable else "available"
                ),
                "input_cost_usd": None,
                "output_cost_usd": None,
                "cost_usd": None,
            }
        )
        if total["cost_status"] == "available":
            total["input_cost_usd"] = sum(row["input_cost_usd"] or 0.0 for row in model_rows)
            total["output_cost_usd"] = sum(row["output_cost_usd"] or 0.0 for row in model_rows)
            total["cost_usd"] = available_cost
        by_agent.append(total)

    interaction_count = sum(row["interaction_count"] for row in by_model)
    input_tokens = sum(row["input_tokens"] for row in by_model)
    output_tokens = sum(row["output_tokens"] for row in by_model)
    unavailable = any(row["cost_status"] == "unavailable" for row in by_model)
    has_available = any(row["cost_status"] == "available" for row in by_model)
    available_cost = sum(
        (row["cost_usd"] or 0.0) for row in by_model
    )
    cost_status = "partial" if unavailable and has_available else (
        "unavailable" if unavailable else "available"
    )
    summary = {
        "interaction_count": interaction_count,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_status": cost_status,
        "input_cost_usd": None,
        "output_cost_usd": None,
        "cost_usd": None,
    }
    if cost_status == "available":
        summary["input_cost_usd"] = sum(row["input_cost_usd"] or 0.0 for row in by_model)
        summary["output_cost_usd"] = sum(row["output_cost_usd"] or 0.0 for row in by_model)
        summary["cost_usd"] = available_cost

    return {
        "lookback_days": LOOKBACK_DAYS,
        "summary": summary,
        "by_model": by_model,
        "by_agent": by_agent,
        "daily_by_model": daily_by_model,
    }
