"""Cached, session-scoped LangChain conversation agents."""

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
import json
import logging
import time
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from utils.config import get_config
from services.agent_repository import get_session_history
from services.model_execution import ModelResponse, get_model_execution
from services.tool_runtime import build_langchain_tools


logger = logging.getLogger("ai_harness.conversation_agent")

HIGHCHARTS_CHART_SYSTEM_PROMPT = """When the user explicitly asks for a chart or visualization, return only valid JSON with no Markdown fences or prose: {\"type\":\"chart\",\"content\":{\"library\":\"highcharts\",\"options\":{...}}}. The options value must be a JSON-serializable Highcharts configuration with chart, title, axes as needed, and series. Use only facts available from tools or the conversation; do not invent financial data. For non-chart requests, respond normally."""


@dataclass
class ConversationAgent:
    """The runtime state for one agent and one conversation session."""

    agent_id: str
    session_id: str
    system_prompts: list[str]
    executor: Any
    history: list[BaseMessage]
    guardrails: dict[str, Any]
    tools: list[Any]
    definition_signature: str
    last_accessed: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def execute(self, user_prompt: str, event_sink: Any | None = None) -> ModelResponse:
        """Send the current context and incoming prompt to the configured model."""
        self.last_accessed = time.monotonic()
        if event_sink is None:
            return await self.executor.execute_with_metadata(
                user_prompt, self.system_prompts, list(self.history), self.tools
            )
        return await self.executor.execute_with_metadata(
            user_prompt,
            self.system_prompts,
            list(self.history),
            self.tools,
            event_sink=event_sink,
        )

    def add_successful_turn(self, user_prompt: str, response_text: str) -> None:
        """Add only a durably audited turn to the in-memory context."""
        self.history.extend(
            [HumanMessage(content=user_prompt), AIMessage(content=response_text)]
        )
        message_limit = get_config().chat_history_message_limit
        if len(self.history) > message_limit:
            self.history = self.history[-message_limit:]
        self.last_accessed = time.monotonic()


class ConversationAgentCache:
    """A bounded process-local cache backed by durable chat audit records."""

    def __init__(self) -> None:
        self._agents: OrderedDict[tuple[str, str], ConversationAgent] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get_or_create(
        self, agent: dict[str, Any], session_id: str
    ) -> ConversationAgent:
        """Return a live session agent, rebuilding its context from MySQL if necessary."""
        cache_key = (agent["agent_id"], session_id)
        async with self._lock:
            self._evict_expired()
            cached = self._agents.get(cache_key)
            if cached is not None and cached.definition_signature == self._definition_signature(agent):
                cached.last_accessed = time.monotonic()
                self._agents.move_to_end(cache_key)
                return cached

            runtime_agent = self._create_runtime_agent(agent, session_id)
            self._agents[cache_key] = runtime_agent
            self._evict_overflow()
            return runtime_agent

    def _create_runtime_agent(
        self, agent: dict[str, Any], session_id: str
    ) -> ConversationAgent:
        config = get_config()
        interaction_limit = (config.chat_history_message_limit + 1) // 2
        turns = get_session_history(agent["agent_id"], session_id, interaction_limit)
        history: list[BaseMessage] = []
        for turn in turns:
            history.extend(
                [
                    HumanMessage(content=turn["user_prompt"]),
                    AIMessage(content=turn["response"]),
                ]
            )

        return ConversationAgent(
            agent_id=agent["agent_id"],
            session_id=session_id,
            system_prompts=[*(agent.get("system_prompts") or []), HIGHCHARTS_CHART_SYSTEM_PROMPT],
            executor=get_model_execution(agent["model_type"], agent["model_id"]),
            history=history[-config.chat_history_message_limit :],
            guardrails=agent.get("guardrails") or {},
            tools=build_langchain_tools(agent.get("tooling") or []),
            definition_signature=self._definition_signature(agent),
        )

    @staticmethod
    def _definition_signature(agent: dict[str, Any]) -> str:
        """Identify configuration changes that require a runtime refresh."""
        return json.dumps(
            {
                "model_type": agent["model_type"],
                "model_id": agent["model_id"],
                "system_prompts": agent.get("system_prompts") or [],
                "tooling": [
                    {
                        "name": tool["name"],
                        "description": tool["description"],
                        "source_code": tool["source_code"],
                        "enabled": tool["enabled"],
                    }
                    for tool in agent.get("tooling") or []
                ],
                "guardrails": agent.get("guardrails") or {},
            },
            sort_keys=True,
        )

    def _evict_expired(self) -> None:
        expiry = get_config().chat_session_cache_ttl_seconds
        cutoff = time.monotonic() - expiry
        expired_keys = [
            cache_key
            for cache_key, runtime_agent in self._agents.items()
            if runtime_agent.last_accessed < cutoff and not runtime_agent.lock.locked()
        ]
        for cache_key in expired_keys:
            self._agents.pop(cache_key, None)

    def _evict_overflow(self) -> None:
        max_size = get_config().chat_session_cache_max_size
        attempts = len(self._agents)
        while len(self._agents) > max_size and attempts:
            cache_key, runtime_agent = next(iter(self._agents.items()))
            if runtime_agent.lock.locked():
                self._agents.move_to_end(cache_key)
                attempts -= 1
                continue
            self._agents.popitem(last=False)
            attempts = len(self._agents)


conversation_agent_cache = ConversationAgentCache()
