"""Constants and runtime definition for chat without a persisted agent."""

from typing import Any


DIRECT_CHAT_AGENT_ID = "00000000-0000-0000-0000-000000000000"
DIRECT_CHAT_AGENT_NAME = "AI Assistant"
DIRECT_CHAT_MODELS = ("gpt-5.4-mini", "gpt-4.1-mini")
DEFAULT_DIRECT_CHAT_MODEL = DIRECT_CHAT_MODELS[0]


def build_direct_chat_agent(model_id: str) -> dict[str, Any]:
    """Build the ephemeral definition used for model-only chat."""
    return {
        "agent_id": DIRECT_CHAT_AGENT_ID,
        "agent_name": DIRECT_CHAT_AGENT_NAME,
        "description": "General-purpose direct model chat.",
        "model_id": model_id,
        "model_type": "openai",
        "tooling": [],
        "system_prompts": [],
        "user_prompts": [],
        "guardrails": {},
    }
