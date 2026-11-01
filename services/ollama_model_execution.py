"""LangChain-backed local Ollama model execution."""

import logging
import os
from typing import Any

from langchain_ollama import ChatOllama

from utils.config import get_config
from services.model_execution import (
    ModelExecutionError,
    ModelResponse,
    classify_guardrail_request,
    get_model_response_attributes,
)
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from services.langchain_tracing import LangChainTrace, invoke_model_with_tools


logger = logging.getLogger("ai_harness.ollama_model_execution")
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"


class OllamaModelExecution:
    """Execute one stateless prompt against the configured local Ollama model."""

    def __init__(self, chat_model: Any | None = None, model_name: str | None = None) -> None:
        self._model_name = model_name or get_config().ollama_model
        self._base_url = os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL)
        self._chat_model = chat_model or ChatOllama(
            model=self._model_name,
            base_url=self._base_url,
        )
        logger.info(
            "Ollama model execution initialized model=%s base_url=%s",
            self._model_name,
            self._base_url,
        )

    async def execute(self, prompt: str, system_prompts: list[str] | None = None) -> str:
        """Invoke the local model and return only its textual response."""
        return (await self.execute_with_metadata(prompt, system_prompts)).text

    async def classify_guardrail(self, policy_text: str, prompt: str, history: list[BaseMessage]) -> bool:
        return await classify_guardrail_request(self._chat_model, policy_text, prompt, history)

    async def execute_with_metadata(
        self,
        prompt: str,
        system_prompts: list[str] | None = None,
        history: list[BaseMessage] | None = None,
        tools: list[Any] | None = None,
        event_sink: Any | None = None,
    ) -> ModelResponse:
        """Invoke the local model and return its textual response."""
        messages = [SystemMessage(content=value) for value in system_prompts or []]
        messages.extend(history or [])
        messages.append(HumanMessage(content=prompt))

        chat_model = self._chat_model.bind_tools(tools) if tools else self._chat_model
        trace = LangChainTrace("ollama", self._model_name, event_sink)
        trace.event(
            "runtime.execution.start",
            system_prompts=system_prompts or [],
            history=history or [],
            user_prompt=prompt,
            tools=tools or [],
        )
        trace.event("runtime.model.bind_tools", tool_names=[tool.name for tool in tools or []])
        try:
            response, input_tokens, output_tokens = await invoke_model_with_tools(
                chat_model=chat_model,
                messages=messages,
                tools=tools or [],
                trace=trace,
                logger=logger,
            )
        except Exception as exc:
            logger.exception(
                "Ollama model request failed model=%s base_url=%s exception_type=%s",
                self._model_name,
                self._base_url,
                type(exc).__name__,
            )
            raise ModelExecutionError("The Ollama provider request failed") from exc

        logger.info("Ollama model request completed model=%s", self._model_name)
        trace.event(
            "runtime.execution.end",
            response=response,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            attributes=get_model_response_attributes(response),
        )
        return ModelResponse(
            text=str(response.content),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            attributes=get_model_response_attributes(response),
        )
