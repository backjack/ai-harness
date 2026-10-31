"""Verbose, console-oriented tracing for LangChain invocations."""

import json
import logging
from time import monotonic
from typing import Any, Callable
from uuid import uuid4

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import BaseMessage


trace_logger = logging.getLogger("ai_harness.langchain_trace")


def _json_default(value: Any) -> Any:
    if isinstance(value, BaseMessage):
        return {
            "message_type": type(value).__name__,
            "content": value.content,
            "additional_kwargs": value.additional_kwargs,
            "response_metadata": value.response_metadata,
            "tool_calls": getattr(value, "tool_calls", None),
        }
    if hasattr(value, "model_dump") and not isinstance(value, type):
        try:
            return value.model_dump()
        except (TypeError, ValueError):
            pass
    return repr(value)


class LangChainTrace(BaseCallbackHandler):
    """Emit complete JSON records for one model execution and its tool calls."""

    def __init__(
        self,
        provider: str,
        model: str,
        event_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.trace_id = str(uuid4())
        self.provider = provider
        self.model = model
        self._event_sink = event_sink

    @property
    def config(self) -> dict[str, Any]:
        return {"callbacks": [self], "metadata": {"trace_id": self.trace_id}}

    def event(self, event: str, **details: Any) -> None:
        payload = {
            "trace_id": self.trace_id,
            "event": event,
            "provider": self.provider,
            "model": self.model,
            **details,
        }
        trace_logger.info("%s", json.dumps(payload, default=_json_default, ensure_ascii=False))
        if self._event_sink is not None:
            self._event_sink(payload.copy())

    def on_chat_model_start(
        self, serialized: dict[str, Any], messages: list[list[BaseMessage]], **kwargs: Any
    ) -> None:
        self.event(
            "langchain.chat_model.start",
            run_id=str(kwargs.get("run_id")),
            parent_run_id=str(kwargs.get("parent_run_id")),
            serialized=serialized,
            messages=messages,
        )

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        self.event(
            "langchain.chat_model.end",
            run_id=str(kwargs.get("run_id")),
            response=response,
        )

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        self.event(
            "langchain.chat_model.error",
            run_id=str(kwargs.get("run_id")),
            error_type=type(error).__name__,
            error=str(error),
        )

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, **kwargs: Any) -> None:
        self.event(
            "langchain.tool.start",
            run_id=str(kwargs.get("run_id")),
            serialized=serialized,
            input=input_str,
        )

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        self.event("langchain.tool.end", run_id=str(kwargs.get("run_id")), output=output)

    def on_tool_error(self, error: BaseException, **kwargs: Any) -> None:
        self.event(
            "langchain.tool.error",
            run_id=str(kwargs.get("run_id")),
            error_type=type(error).__name__,
            error=str(error),
        )


async def invoke_model_with_tools(
    *,
    chat_model: Any,
    messages: list[BaseMessage],
    tools: list[Any],
    trace: LangChainTrace,
    logger: logging.Logger,
    max_iterations: int = 5,
) -> tuple[Any, int, int]:
    """Invoke a bound chat model, run requested tools, and trace every step."""
    input_tokens = output_tokens = 0
    tools_by_name = {tool.name: tool for tool in tools}

    for iteration in range(1, max_iterations + 1):
        trace.event("runtime.model.invoke.start", iteration=iteration, messages=messages)
        started_at = monotonic()
        try:
            response = await chat_model.ainvoke(messages, config=trace.config)
        except Exception as exc:
            trace.event(
                "runtime.model.invoke.error",
                iteration=iteration,
                duration_ms=round((monotonic() - started_at) * 1000, 2),
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

        usage = getattr(response, "usage_metadata", {}) or {}
        input_tokens += int(usage.get("input_tokens", 0))
        output_tokens += int(usage.get("output_tokens", 0))
        tool_calls = getattr(response, "tool_calls", None) or []
        trace.event(
            "runtime.model.invoke.end",
            iteration=iteration,
            duration_ms=round((monotonic() - started_at) * 1000, 2),
            response=response,
            tool_calls=tool_calls,
            usage=usage,
        )
        if not tool_calls:
            return response, input_tokens, output_tokens

        messages.append(response)
        for call in tool_calls:
            tool_name = call["name"]
            arguments = call.get("args", {})
            tool = tools_by_name.get(tool_name)
            trace.event(
                "runtime.tool.invoke.start",
                iteration=iteration,
                tool_call_id=call["id"],
                tool_name=tool_name,
                arguments=arguments,
            )
            started_at = monotonic()
            if tool is None:
                result = f"Tool '{tool_name}' is unavailable."
                trace.event(
                    "runtime.tool.invoke.unavailable",
                    iteration=iteration,
                    tool_call_id=call["id"],
                    tool_name=tool_name,
                    result=result,
                )
            else:
                try:
                    result = await tool.ainvoke(arguments, config=trace.config)
                except Exception as exc:
                    logger.exception("Tool execution failed tool=%s", tool_name)
                    result = f"Tool execution failed: {type(exc).__name__}"
                    trace.event(
                        "runtime.tool.invoke.error",
                        iteration=iteration,
                        tool_call_id=call["id"],
                        tool_name=tool_name,
                        arguments=arguments,
                        error_type=type(exc).__name__,
                        error=str(exc),
                    )
            trace.event(
                "runtime.tool.invoke.end",
                iteration=iteration,
                tool_call_id=call["id"],
                tool_name=tool_name,
                arguments=arguments,
                result=result,
                duration_ms=round((monotonic() - started_at) * 1000, 2),
            )
            from langchain_core.messages import ToolMessage

            tool_message = ToolMessage(content=str(result), tool_call_id=call["id"])
            messages.append(tool_message)
            trace.event(
                "runtime.tool.message.appended",
                iteration=iteration,
                tool_call_id=call["id"],
                message=tool_message,
            )

    trace.event("runtime.tool_call_limit.exceeded", max_iterations=max_iterations)
    raise RuntimeError("Tool call limit exceeded")
