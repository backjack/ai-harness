"""LangChain-backed OpenAI execution and provider selection."""

import logging
import os
from functools import lru_cache
from typing import Any

from langchain_openai import ChatOpenAI
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from utils.config import get_config
from services.langchain_tracing import LangChainTrace, invoke_model_with_tools


logger = logging.getLogger("ai_harness.model_execution")


class ModelExecutionError(Exception):
    """Raised when the model cannot produce a response."""


class ModelNotConfiguredError(ModelExecutionError):
    """Raised when the OpenAI API key has not been configured."""


class ModelResponse:
    """Text and token metadata returned by a chat model."""

    def __init__(
        self,
        text: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        self.text = text
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.attributes = attributes or {}


def get_model_response_attributes(response: Any) -> dict[str, Any]:
    """Return stable, JSON-safe fields from the final LangChain model message."""
    return {
        "content": getattr(response, "content", None),
        "message_type": getattr(response, "type", type(response).__name__),
        "id": getattr(response, "id", None),
        "name": getattr(response, "name", None),
        "tool_calls": getattr(response, "tool_calls", None),
        "invalid_tool_calls": getattr(response, "invalid_tool_calls", None),
        "additional_kwargs": getattr(response, "additional_kwargs", None),
        "response_metadata": getattr(response, "response_metadata", None),
        "usage_metadata": getattr(response, "usage_metadata", None),
    }


class ModelExecution:
    """Execute one stateless prompt against the configured chat model."""

    def __init__(self, chat_model: Any | None = None, model_name: str | None = None) -> None:
        if not os.getenv("OPENAI_API_KEY"):
            logger.error("Model execution is unavailable because OPENAI_API_KEY is missing")
            raise ModelNotConfiguredError("OPENAI_API_KEY is not configured")

        self._model_name = model_name or get_config().openai_model
        self._chat_model = chat_model or ChatOpenAI(model=self._model_name)
        logger.info("Model execution initialized model=%s", self._model_name)

    async def execute(self, prompt: str, system_prompts: list[str] | None = None) -> str:
        """Invoke the model and return only its textual response."""
        return (await self.execute_with_metadata(prompt, system_prompts)).text

    async def execute_with_metadata(
        self,
        prompt: str,
        system_prompts: list[str] | None = None,
        history: list[BaseMessage] | None = None,
        tools: list[Any] | None = None,
        event_sink: Any | None = None,
    ) -> ModelResponse:
        """Invoke the model and return its textual response."""
        messages = [SystemMessage(content=value) for value in system_prompts or []]
        messages.extend(history or [])
        messages.append(HumanMessage(content=prompt))

        chat_model = self._chat_model.bind_tools(tools) if tools else self._chat_model
        trace = LangChainTrace("openai", self._model_name, event_sink)
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
                "Model request failed model=%s exception_type=%s status_code=%s request_id=%s",
                self._model_name,
                type(exc).__name__,
                getattr(exc, "status_code", None),
                getattr(exc, "request_id", None),
            )
            raise ModelExecutionError("The model provider request failed") from exc

        logger.info(
            "Model request completed model=%s request_id=%s",
            self._model_name,
            getattr(response, "response_metadata", {}).get("request_id"),
        )
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


@lru_cache
def get_model_execution(
    provider: str | None = None, model_id: str | None = None
) -> ModelExecution | Any:
    """Create the configured provider executor once for the application process."""
    selected_provider = provider or get_config().chat_provider
    if selected_provider == "ollama":
        from services.ollama_model_execution import OllamaModelExecution

        return OllamaModelExecution(model_name=model_id)

    if selected_provider == "openai":
        return ModelExecution(model_name=model_id)

    raise ModelExecutionError("Unsupported model provider")
