import asyncio
from datetime import datetime, timezone
import io
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from main import app
from controllers.service_status import _classify_message
from services.analytics import get_analytics_report
from services.agent_repository import _decode_agent, _serialize_agent_values, update_agent as update_stored_agent
from services.chat_events import ChatEventSink
from services.conversation_agent import TOOL_USE_SYSTEM_PROMPT
from services.langchain_tracing import MAX_TOOL_CALLS, LangChainTrace, invoke_model_with_tools
from services.mcp_client import call_mcp_tool as execute_mcp_call
from services.tool_library import discover_source, test_inline_tool as execute_inline_tool, test_tool as execute_library_tool
from utils.config import get_config
from services.model_execution import (
    ModelExecution,
    ModelExecutionError,
    ModelNotConfiguredError,
    ModelResponse,
    get_model_execution,
)
from services.ollama_model_execution import OllamaModelExecution
from services.tool_runtime import (
    ToolFunctionValidationError,
    build_langchain_tools,
    validate_tool_definitions,
)
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage


client = TestClient(app)


def agent_record() -> dict[str, object]:
    return {
        "agent_id": "11111111-1111-1111-1111-111111111111",
        "agent_name": "Assistant",
        "description": "Helpful assistant.",
        "initiative_id": "initiative-123",
        "faq": {"What can you do?": "I can help."},
        "owner_email": "owner@example.com",
        "shared_with": [],
        "model_id": "gpt-5.4-mini",
        "tooling": [],
        "system_prompts": ["Be helpful."],
        "user_prompts": [],
        "model_type": "openai",
        "guardrails": {},
        "created_by": "owner@example.com",
        "created_at": datetime.now(timezone.utc),
        "last_updated_at": datetime.now(timezone.utc),
    }


def test_root_returns_service_identifier() -> None:
    response = client.get("/api/")

    assert response.status_code == 200
    assert response.json() == {"message": "AI Harness API"}


def test_health_check_reports_ok() -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_database_health_reports_ready(monkeypatch) -> None:
    monkeypatch.setattr(
        "controllers.service_status.check_database_readiness", lambda: None
    )

    response = client.get("/api/health/database")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_database_health_reports_unavailable(monkeypatch) -> None:
    def unavailable() -> None:
        from utils.database import DatabaseUnavailableError

        raise DatabaseUnavailableError("unreachable")

    monkeypatch.setattr("controllers.service_status.check_database_readiness", unavailable)

    response = client.get("/api/health/database")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database service is unavailable"}


def test_app_metadata_is_loaded_from_configuration() -> None:
    config = get_config()

    assert app.title == config.title
    assert app.version == config.version


def test_frontend_files_and_browser_routes_are_served() -> None:
    from main import frontend_dist

    if not (frontend_dist / "index.html").is_file():
        pytest.skip("Build the frontend before running SPA serving tests")

    assert client.get("/").status_code == 200
    assert '<div id="root"></div>' in client.get("/agents").text
    assert client.get("/conversations/session-1").status_code == 200
    asset = next(path for path in (frontend_dist / "assets").iterdir() if path.is_file())
    assert client.get(f"/assets/{asset.name}").status_code == 200


def test_unknown_api_path_returns_json_not_frontend() -> None:
    response = client.get("/api/missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_swagger_ui_is_available() -> None:
    response = client.get("/api/docs")

    assert response.status_code == 200
    assert "Swagger UI" in response.text
    assert 'src="/api/docs-assets/swagger-ui-bundle.js"' in response.text
    assert 'href="/api/docs-assets/swagger-ui.css"' in response.text
    assert "cdn.jsdelivr.net" not in response.text

    shortcut = client.get("/docs", follow_redirects=False)
    assert shortcut.status_code == 307
    assert shortcut.headers["location"] == "/api/docs"

    assert client.get("/api/docs-assets/swagger-ui-bundle.js").status_code == 200
    assert client.get("/api/docs-assets/swagger-ui.css").status_code == 200
    assert client.get("/api/docs-assets/favicon-32x32.png").status_code == 200
    assert client.get("/api/docs/oauth2-redirect").status_code == 200


def test_openapi_schema_documents_the_api() -> None:
    response = client.get("/api/openapi.json")

    assert response.status_code == 200
    schema = response.json()
    assert schema["info"]["title"] == "AI Harness API"
    assert schema["info"]["version"] == "0.1.0"
    assert {"/api/", "/api/health", "/api/chat", "/api/analytics", "/api/conversations"}.issubset(schema["paths"])
    assert {tag["name"] for tag in schema["tags"]} == {"service", "health", "chat", "analytics", "conversations"}
    assert "ChatRequest" in schema["components"]["schemas"]
    assert "ChatResponse" in schema["components"]["schemas"]
    assert {"200", "422", "502", "503"}.issubset(
        schema["paths"]["/api/chat"]["post"]["responses"]
    )


def test_conversations_returns_five_email_scoped_summaries(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def summaries(email_id: str, *, limit: int) -> list[dict[str, object]]:
        captured.update(email_id=email_id, limit=limit)
        return [{
            "session_id": "session-1",
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "agent_name": "Assistant",
            "title": "Review my portfolio",
            "interaction_count": 3,
            "last_activity_at": datetime(2026, 10, 31, 10, 30, tzinfo=timezone.utc),
        }]

    monkeypatch.setattr("controllers.conversations.list_conversations_by_email", summaries)

    response = client.get("/api/conversations", params={"email_id": "neeraj@example.com"})

    assert response.status_code == 200
    assert captured == {"email_id": "neeraj@example.com", "limit": 5}
    assert response.json()[0]["title"] == "Review my portfolio"
    assert response.json()[0]["interaction_count"] == 3


def test_conversations_requires_email_and_reports_database_failure(monkeypatch) -> None:
    from utils.database import DatabaseUnavailableError

    def unavailable(*args, **kwargs) -> list[dict[str, object]]:
        raise DatabaseUnavailableError("unreachable")

    assert client.get("/api/conversations").status_code == 422
    monkeypatch.setattr("controllers.conversations.list_conversations_by_email", unavailable)

    response = client.get("/api/conversations", params={"email_id": "neeraj@example.com"})

    assert response.status_code == 503
    assert response.json() == {"detail": "Database service is unavailable"}


def test_conversation_detail_returns_complete_email_scoped_transcript(monkeypatch) -> None:
    captured: dict[str, str] = {}

    def detail(email_id: str, session_id: str) -> dict[str, object]:
        captured.update(email_id=email_id, session_id=session_id)
        timestamp = datetime(2026, 10, 31, 10, 30, tzinfo=timezone.utc)
        return {
            "session_id": session_id,
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "agent_name": "Assistant",
            "title": "Review my portfolio",
            "interaction_count": 1,
            "last_activity_at": timestamp,
            "messages": [
                {
                    "role": "user",
                    "content": "Review my portfolio",
                    "created_at": timestamp,
                    "chat_sequence_id": 1,
                },
                {
                    "role": "assistant",
                    "content": '{"type":"chart"}',
                    "response": {
                        "type": "chart",
                        "content": {
                            "library": "highcharts",
                            "options": {"series": [{"data": [40, 60]}]},
                        },
                    },
                    "created_at": timestamp,
                    "chat_sequence_id": 1,
                },
            ],
        }

    monkeypatch.setattr("controllers.conversations.get_conversation_by_email", detail)

    response = client.get(
        "/api/conversations/session-1", params={"email_id": "neeraj@example.com"}
    )

    assert response.status_code == 200
    assert captured == {"email_id": "neeraj@example.com", "session_id": "session-1"}
    assert [message["role"] for message in response.json()["messages"]] == [
        "user",
        "assistant",
    ]
    assert response.json()["messages"][1]["response"] == {
        "type": "chart",
        "content": {
            "library": "highcharts",
            "options": {"series": [{"data": [40, 60]}]},
        },
    }


def test_legacy_conversation_chart_is_reclassified_from_raw_response(monkeypatch) -> None:
    from services.conversation_repository import get_conversation_by_email

    timestamp = datetime(2026, 10, 31, 10, 30, tzinfo=timezone.utc)
    rows = [{
        "agent_id": "11111111-1111-1111-1111-111111111111",
        "agent_name": "Assistant",
        "input_payload": {"user_prompt": "Chart my allocation"},
        "output_payload": {
            "response": '{"type":"chart","content":{"library":"highcharts","options":{"series":[{"data":[40,60]}]}}}'
        },
        "chat_sequence_id": 1,
        "created_at": timestamp,
    }]

    class Cursor:
        def execute(self, query: str, parameters: tuple[str, str]) -> None:
            assert "interactions.user_id = %s" in query
            assert parameters == ("neeraj@example.com", "session-1")

        def fetchall(self) -> list[dict[str, object]]:
            return rows

        def close(self) -> None:
            pass

    class Connection:
        def cursor(self, *, dictionary: bool) -> Cursor:
            assert dictionary is True
            return Cursor()

        def close(self) -> None:
            pass

    class Pool:
        def get_connection(self) -> Connection:
            return Connection()

    monkeypatch.setattr(
        "services.conversation_repository.get_connection_pool", lambda: Pool()
    )

    conversation = get_conversation_by_email("neeraj@example.com", "session-1")

    assert conversation is not None
    assert conversation["messages"][1]["response"] == {
        "type": "chart",
        "content": {
            "library": "highcharts",
            "options": {"series": [{"data": [40, 60]}]},
        },
    }


def test_conversation_detail_hides_other_users_and_reports_database_failure(monkeypatch) -> None:
    from utils.database import DatabaseUnavailableError

    monkeypatch.setattr(
        "controllers.conversations.get_conversation_by_email", lambda *args: None
    )
    response = client.get(
        "/api/conversations/session-1", params={"email_id": "other@example.com"}
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Conversation not found"}

    def unavailable(*args) -> None:
        raise DatabaseUnavailableError("unreachable")

    monkeypatch.setattr(
        "controllers.conversations.get_conversation_by_email", unavailable
    )
    response = client.get(
        "/api/conversations/session-1", params={"email_id": "neeraj@example.com"}
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Database service is unavailable"}


def test_analytics_reports_luna_costs_and_unpriced_models(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.analytics.get_analytics_usage",
        lambda **kwargs: {
            "by_model": [
                {"model_id": "gpt-5.6-luna", "interaction_count": 2, "input_tokens": 1_000_000, "output_tokens": 500_000},
                {"model_id": "unsupported-model", "interaction_count": 1, "input_tokens": 10, "output_tokens": 20},
            ],
            "by_agent": [
                {"agent_id": "a", "agent_name": "Luna", "model_id": "gpt-5.6-luna", "interaction_count": 2, "input_tokens": 1_000_000, "output_tokens": 500_000},
                {"agent_id": "b", "agent_name": "Legacy", "model_id": "unsupported-model", "interaction_count": 1, "input_tokens": 10, "output_tokens": 20},
            ],
        },
    )

    report = get_analytics_report()

    assert report["summary"] == {
        "interaction_count": 3,
        "input_tokens": 1_000_010,
        "output_tokens": 500_020,
        "cost_status": "partial",
        "input_cost_usd": None,
        "output_cost_usd": None,
        "cost_usd": None,
    }
    assert report["by_model"][0]["cost_usd"] == 0.8
    assert report["by_model"][1]["cost_status"] == "unavailable"
    assert report["by_agent"][0]["agent_name"] == "Luna"
    assert report["by_agent"][0]["cost_usd"] == 0.8


def test_analytics_calculates_gpt_5_4_mini_costs(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.analytics.get_analytics_usage",
        lambda **kwargs: {
            "by_model": [{
                "model_id": "gpt-5.4-mini",
                "interaction_count": 2,
                "input_tokens": 1_000_000,
                "output_tokens": 500_000,
            }],
            "by_agent": [{
                "agent_id": "agent-1",
                "agent_name": "Analyst",
                "model_id": "gpt-5.4-mini",
                "interaction_count": 2,
                "input_tokens": 1_000_000,
                "output_tokens": 500_000,
            }],
        },
    )

    report = get_analytics_report()

    assert report["summary"]["cost_status"] == "available"
    assert report["summary"]["input_cost_usd"] == 0.75
    assert report["summary"]["output_cost_usd"] == 2.25
    assert report["summary"]["cost_usd"] == 3.0
    assert report["by_model"][0]["cost_usd"] == 3.0
    assert report["by_agent"][0]["cost_usd"] == 3.0


def test_analytics_calculates_gpt_4_1_mini_costs(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.analytics.get_analytics_usage",
        lambda **kwargs: {
            "by_model": [{
                "model_id": "gpt-4.1-mini",
                "interaction_count": 1,
                "input_tokens": 1_000_000,
                "output_tokens": 500_000,
            }],
            "by_agent": [{
                "agent_id": "agent-1",
                "agent_name": "Legacy assistant",
                "model_id": "gpt-4.1-mini",
                "interaction_count": 1,
                "input_tokens": 1_000_000,
                "output_tokens": 500_000,
            }],
        },
    )

    report = get_analytics_report()

    assert report["summary"]["cost_status"] == "available"
    assert report["summary"]["input_cost_usd"] == 0.4
    assert report["summary"]["output_cost_usd"] == 0.8
    assert report["summary"]["cost_usd"] == 1.2
    assert report["by_model"][0]["cost_usd"] == 1.2
    assert report["by_agent"][0]["cost_usd"] == 1.2


def test_analytics_endpoint_reports_database_failure(monkeypatch) -> None:
    from utils.database import DatabaseUnavailableError

    def unavailable() -> dict[str, object]:
        raise DatabaseUnavailableError("unreachable")

    monkeypatch.setattr("controllers.analytics.get_analytics_report", unavailable)

    response = client.get("/api/analytics")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database service is unavailable"}


def test_chat_returns_model_response(monkeypatch) -> None:
    audited: dict[str, object] = {}

    class FakeModelExecution:
        async def execute_with_metadata(
            self, prompt: str, system_prompts: list[str], history: list[object], tools: list[object]
        ) -> ModelResponse:
            assert prompt == "Hello"
            assert system_prompts[0] == "Be helpful."
            assert "highcharts" in system_prompts[1]
            return ModelResponse("Hi there!", input_tokens=3, output_tokens=2)

    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: agent_record())
    monkeypatch.setattr("services.conversation_agent.get_session_history", lambda *args: [])
    monkeypatch.setattr("services.conversation_agent.get_model_execution", lambda *args: FakeModelExecution())
    def audit(**kwargs: object) -> int:
        audited.update(kwargs)
        return 1

    monkeypatch.setattr("controllers.service_status.record_successful_chat", audit)

    response = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "Hello",
            "session_id": "session-1",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response"] == {"type": "markdown", "content": "Hi there!"}
    assert payload["model_response"] == {}
    assert payload["session_id"] == "session-1"
    assert payload["chat_sequence_id"] == 1
    assert payload["chat_event_id"]
    assert audited["response_message"] == {
        "type": "markdown",
        "content": "Hi there!",
    }


def test_conversation_guardrail_blocks_before_model_and_tools() -> None:
    from services.conversation_agent import ConversationAgent

    calls: list[str] = []

    class FakeExecutor:
        async def classify_guardrail(self, policy: str, prompt: str, history: list[object]) -> bool:
            calls.append("classify")
            assert policy == "Only provide financial guidance."
            assert prompt == "Write malware"
            assert len(history) == 1
            return False

        async def execute_with_metadata(self, *args: object, **kwargs: object) -> ModelResponse:
            calls.append("execute")
            return ModelResponse("should not run")

    events: list[dict[str, object]] = []
    runtime = ConversationAgent(
        agent_id="agent-1", session_id="session-1", system_prompts=[], executor=FakeExecutor(),
        history=[HumanMessage(content="Earlier context")],
        guardrails={"policy_text": "Only provide financial guidance.", "out_of_scope_response": "Request blocked."},
        tools=[object()], definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Write malware", events.append))

    assert result.text == "Request blocked."
    assert calls == ["classify"]
    assert events[-1]["event"] == "runtime.guardrail.evaluate.blocked"


def test_conversation_guardrail_allows_normal_execution() -> None:
    from services.conversation_agent import ConversationAgent

    observed_prompts: list[str] = []

    class FakeExecutor:
        async def classify_guardrail(self, *args: object) -> bool:
            return True

        async def execute_with_metadata(
            self,
            prompt: str,
            system_prompts: list[str],
            history: list[object],
            tools: list[object],
            **kwargs: object,
        ) -> ModelResponse:
            observed_prompts.extend(system_prompts)
            return ModelResponse("Allowed response")

    runtime = ConversationAgent(
        agent_id="agent-1", session_id="session-1", system_prompts=[], executor=FakeExecutor(), history=[],
        guardrails={"policy_text": "Only provide financial guidance.", "out_of_scope_response": "Blocked."},
        tools=[], definition_signature="signature",
    )

    assert asyncio.run(runtime.execute("Explain an invoice")).text == "Allowed response"
    assert any("Only provide financial guidance." in prompt for prompt in observed_prompts)


def test_conversation_guardrail_builds_blocked_topic_policy() -> None:
    from services.conversation_agent import ConversationAgent

    observed_policies: list[str] = []

    class FakeExecutor:
        async def classify_guardrail(self, policy: str, *args: object) -> bool:
            observed_policies.append(policy)
            return False

        async def execute_with_metadata(self, *args: object, **kwargs: object) -> ModelResponse:
            raise AssertionError("Normal model execution must not run for a blocked request")

    runtime = ConversationAgent(
        agent_id="agent-1", session_id="session-1", system_prompts=[], executor=FakeExecutor(), history=[],
        guardrails={"blocked_topics": ["restricted-topic"], "out_of_scope_response": "Request blocked."},
        tools=[object()], definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Tell me about restricted-topic"))

    assert result.text == "Request blocked."
    assert observed_policies == ["Do not allow requests related to these topics: restricted-topic."]


def test_conversation_cache_signature_changes_with_guardrails() -> None:
    from services.conversation_agent import ConversationAgentCache

    agent = agent_record()
    original_signature = ConversationAgentCache._definition_signature(agent)
    agent["guardrails"] = {"blocked_topics": ["restricted-topic"]}

    assert ConversationAgentCache._definition_signature(agent) != original_signature


def test_conversation_guardrail_classifier_failure_blocks_safely() -> None:
    from services.conversation_agent import ConversationAgent

    class FailingExecutor:
        async def classify_guardrail(self, *args: object) -> bool:
            raise ValueError("invalid classifier output")

    runtime = ConversationAgent(
        agent_id="agent-1", session_id="session-1", system_prompts=[], executor=FailingExecutor(), history=[],
        guardrails={"allowed_topics": ["finance"], "out_of_scope_response": "Safe fallback."},
        tools=[], definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Anything"))

    assert result.text == "Safe fallback."
    assert result.attributes["guardrail"]["classification_failed"] is True


def test_conversation_guardrail_generates_agent_refusal_when_no_custom_fallback() -> None:
    from services.conversation_agent import ConversationAgent

    captured_calls: list[dict[str, object]] = []

    class FakeExecutor:
        async def classify_guardrail(self, policy: str, prompt: str, history: list[object]) -> bool:
            return False

        async def execute_with_metadata(
            self,
            prompt: str,
            system_prompts: list[str],
            history: list[object],
            tools: list[object],
            **kwargs: object,
        ) -> ModelResponse:
            captured_calls.append({
                "prompt": prompt,
                "system_prompts": system_prompts,
                "history": history,
                "tools": tools,
            })
            return ModelResponse(
                "I am a financial assistant and can only help with stock queries. I cannot write poetry.",
                attributes={"model": "fake"},
            )

    runtime = ConversationAgent(
        agent_id="agent-1",
        session_id="session-1",
        system_prompts=["You are a financial analyst."],
        executor=FakeExecutor(),
        history=[HumanMessage(content="Hello")],
        guardrails={"policy_text": "Only financial queries allowed."},
        tools=[object()],
        definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Write a poem"))

    assert result.text == "I am a financial assistant and can only help with stock queries. I cannot write poetry."
    assert result.attributes["guardrail"]["allowed"] is False
    assert len(captured_calls) == 1
    call = captured_calls[0]
    assert call["prompt"] == "Write a poem"
    assert call["tools"] == []
    assert any("You are a financial analyst." in p for p in call["system_prompts"])
    assert any("The user's request cannot be fulfilled" in p for p in call["system_prompts"])


def test_conversation_guardrail_meaningful_default_fallback_without_model() -> None:
    from services.conversation_agent import ConversationAgent

    class ClassifyOnlyExecutor:
        async def classify_guardrail(self, *args: object) -> bool:
            return False

        async def execute_with_metadata(self, *args: object, **kwargs: object) -> ModelResponse:
            raise RuntimeError("Model execution unavailable")

    runtime = ConversationAgent(
        agent_id="agent-1",
        session_id="session-1",
        system_prompts=[],
        executor=ClassifyOnlyExecutor(),
        history=[],
        guardrails={"allowed_topics": ["stocks", "bonds"]},
        tools=[],
        definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Bake bread"))

    assert "I'm sorry, but I can only assist with requests related to: stocks, bonds." in result.text
    assert result.attributes["guardrail"]["allowed"] is False


def test_conversation_guardrail_legacy_unhelpful_string_replaced_by_agent() -> None:
    from services.conversation_agent import ConversationAgent

    class FakeExecutor:
        async def classify_guardrail(self, *args: object) -> bool:
            return False

        async def execute_with_metadata(
            self, prompt: str, system_prompts: list[str], *args: object, **kwargs: object
        ) -> ModelResponse:
            return ModelResponse("I can only assist with investment guidance.")

    runtime = ConversationAgent(
        agent_id="agent-1",
        session_id="session-1",
        system_prompts=["Help with investments."],
        executor=FakeExecutor(),
        history=[],
        guardrails={
            "policy_text": "Only investments.",
            "out_of_scope_response": "I can't help with that request.",
        },
        tools=[],
        definition_signature="signature",
    )

    result = asyncio.run(runtime.execute("Bake cookies"))

    assert result.text == "I can only assist with investment guidance."
    assert result.attributes["guardrail"]["allowed"] is False


def test_chat_stream_emits_model_progress_then_final_response(monkeypatch) -> None:
    class AsyncLock:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakeRuntimeAgent:
        lock = AsyncLock()

        async def execute(self, prompt: str, event_sink: object) -> ModelResponse:
            event_sink.emit("runtime.model.invoke.start", messages=[{"content": prompt}])
            event_sink.emit(
                "runtime.tool.invoke.end",
                tool_name="getMarketPrice",
                result={"symbol": "AAPL", "price": 210.5},
            )
            return ModelResponse(
                '{"symbol": "AAPL", "price": 210.5}',
                attributes={
                    "content": '{"symbol": "AAPL", "price": 210.5}',
                    "message_type": "ai",
                    "id": "response-1",
                    "tool_calls": [],
                    "invalid_tool_calls": [],
                    "additional_kwargs": {},
                    "response_metadata": {"request_id": "request-1"},
                    "usage_metadata": {"input_tokens": 1, "output_tokens": 1},
                },
            )

        def add_successful_turn(self, prompt: str, response: str) -> None:
            pass

    async def get_runtime(*args: object) -> FakeRuntimeAgent:
        return FakeRuntimeAgent()

    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: agent_record())
    monkeypatch.setattr("controllers.service_status.conversation_agent_cache.get_or_create", get_runtime)
    monkeypatch.setattr("controllers.service_status.record_successful_chat", lambda **kwargs: 7)

    with client.stream(
        "POST",
        "/api/chat/stream",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "What is AAPL worth?",
            "session_id": "stream-1",
        },
    ) as response:
        body = "".join(response.iter_text())

    assert response.status_code == 200
    events = [
        json.loads(chunk.split("data: ", 1)[1])
        for chunk in body.strip().split("\n\n")
    ]
    assert [event["event_id"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["chat_event_id"] for event in events}) == 1
    assert {event["type"] for event in events}.issuperset(
        {"runtime.model.invoke.start", "runtime.tool.invoke.end", "chat.audit.success", "final", "complete"}
    )
    final = next(event for event in events if event["type"] == "final")
    assert final["response"]["response"] == {
        "type": "json", "content": {"symbol": "AAPL", "price": 210.5}
    }


def test_final_message_classification_supports_markdown_json_html_and_charts() -> None:
    assert _classify_message("**Stock price:** $204.64", {}).model_dump() == {
        "type": "markdown", "content": "**Stock price:** $204.64"
    }
    assert _classify_message('{"answer": 42}', {}).model_dump() == {
        "type": "json", "content": {"answer": 42}
    }
    assert _classify_message("<p>Stock summary</p>", {}).model_dump() == {
        "type": "html", "content": "<p>Stock summary</p>"
    }
    assert _classify_message(
        '{"type":"chart","content":{"library":"highcharts","options":{"chart":{"type":"column"},"series":[{"data":[100]}]}}}',
        {},
    ).model_dump() == {
        "type": "chart",
        "content": {
            "library": "highcharts",
            "options": {"chart": {"type": "column"}, "series": [{"data": [100]}]},
        },
    }
    assert _classify_message(
        '{"type":"chart","content":{"chart_type":"bar","labels":["AAPL"]}}',
        {},
    ).model_dump() == {
        "type": "json",
        "content": {"type": "chart", "content": {"chart_type": "bar", "labels": ["AAPL"]}},
    }


def test_chat_rejects_missing_or_blank_prompts() -> None:
    missing_prompt = client.post("/api/chat", json={})
    blank_prompt = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-222222222222",
            "user_prompt": "   ",
        },
    )

    assert missing_prompt.status_code == 422
    assert blank_prompt.status_code == 422


def test_chat_reports_missing_model_configuration(monkeypatch) -> None:
    def missing_configuration(provider: str, model_id: str):
        raise ModelNotConfiguredError("missing key")

    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: agent_record())
    monkeypatch.setattr("services.conversation_agent.get_session_history", lambda *args: [])
    monkeypatch.setattr("services.conversation_agent.get_model_execution", missing_configuration)

    response = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "Hello",
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Chat service is not configured"}


def test_chat_reports_provider_failures(monkeypatch) -> None:
    class FailingModelExecution:
        async def execute_with_metadata(
            self, prompt: str, system_prompts: list[str], history: list[object], tools: list[object]
        ) -> ModelResponse:
            raise ModelExecutionError("provider unavailable")

    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: agent_record())
    monkeypatch.setattr("services.conversation_agent.get_session_history", lambda *args: [])
    monkeypatch.setattr("services.conversation_agent.get_model_execution", lambda *args: FailingModelExecution())

    response = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "Hello",
        },
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "Chat service is temporarily unavailable"}


def test_chat_returns_not_found_for_unknown_agent(monkeypatch) -> None:
    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: None)

    response = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "Hello",
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Agent not found"}


def test_chat_returns_database_error_when_audit_fails(monkeypatch) -> None:
    from utils.database import DatabaseUnavailableError

    class FakeModelExecution:
        async def execute_with_metadata(
            self, prompt: str, system_prompts: list[str], history: list[object], tools: list[object]
        ) -> ModelResponse:
            return ModelResponse("Hi there!")

    def audit_failure(**kwargs) -> int:
        raise DatabaseUnavailableError("database unavailable")

    monkeypatch.setattr("controllers.service_status.get_agent", lambda agent_id: agent_record())
    monkeypatch.setattr("services.conversation_agent.get_session_history", lambda *args: [])
    monkeypatch.setattr("services.conversation_agent.get_model_execution", lambda *args: FakeModelExecution())
    monkeypatch.setattr("controllers.service_status.record_successful_chat", audit_failure)

    response = client.post(
        "/api/chat",
        json={
            "agent_id": "11111111-1111-1111-1111-111111111111",
            "user_id": "22222222-2222-2222-2222-222222222222",
            "user_prompt": "Hello",
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Database service is unavailable"}


def test_create_agent_returns_persisted_agent(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def persist(values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        return agent_record()

    monkeypatch.setattr("controllers.agents.create_agent", persist)

    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "description": "Helpful assistant.",
            "initiative_id": "initiative-123",
            "faq": {"What can you do?": "I can help."},
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "tooling": [],
            "model_type": "openai",
            "created_by": "owner@example.com",
        },
    )

    assert response.status_code == 201
    assert response.json()["agent_id"] == agent_record()["agent_id"]
    assert captured["description"] == "Helpful assistant."
    assert captured["initiative_id"] == "initiative-123"
    assert captured["faq"] == {"What can you do?": "I can help."}


def test_create_agent_rejects_response_only_guardrails() -> None:
    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "description": "Helpful assistant.",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "tooling": [],
            "model_type": "openai",
            "guardrails": {"out_of_scope_response": "Topics on restricted-topic"},
            "created_by": "owner@example.com",
        },
    )

    assert response.status_code == 422
    assert "requires policy_text, allowed_topics, or blocked_topics" in response.text


def test_create_agent_accepts_and_normalizes_blocked_topics(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def persist(values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored["guardrails"] = values["guardrails"]
        return stored

    monkeypatch.setattr("controllers.agents.create_agent", persist)

    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "description": "Helpful assistant.",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "tooling": [],
            "model_type": "openai",
            "guardrails": {
                "blocked_topics": [" restricted-topic ", "RESTRICTED-TOPIC"],
                "out_of_scope_response": " Request blocked. ",
            },
            "created_by": "owner@example.com",
        },
    )

    assert response.status_code == 201
    assert captured["guardrails"] == {
        "policy_text": None,
        "allowed_topics": [],
        "blocked_topics": ["restricted-topic"],
        "out_of_scope_response": "Request blocked.",
    }


def test_create_agent_defaults_faq_to_null_storage_and_empty_response(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def persist(values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored["faq"] = {}
        return stored

    monkeypatch.setattr("controllers.agents.create_agent", persist)

    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "model_type": "openai",
            "created_by": "owner@example.com",
        },
    )

    assert response.status_code == 201
    assert captured["faq"] is None
    assert response.json()["faq"] == {}


def test_create_agent_accepts_null_faq(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def persist(values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored["faq"] = {}
        return stored

    monkeypatch.setattr("controllers.agents.create_agent", persist)

    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "model_type": "openai",
            "created_by": "owner@example.com",
            "faq": None,
        },
    )

    assert response.status_code == 201
    assert captured["faq"] is None
    assert response.json()["faq"] == {}


def test_agent_detail_returns_faq_but_list_omits_it(monkeypatch) -> None:
    stored = agent_record()
    monkeypatch.setattr("controllers.agents.get_agent", lambda agent_id: stored)
    monkeypatch.setattr("controllers.agents.list_agents", lambda: [stored])

    detail_response = client.get(f"/api/agents/{stored['agent_id']}")
    list_response = client.get("/api/agents")

    assert detail_response.status_code == 200
    assert detail_response.json()["faq"] == stored["faq"]
    assert list_response.status_code == 200
    assert "faq" not in list_response.json()[0]


@pytest.mark.parametrize(
    "faq",
    [[], {"Question": 123}],
)
def test_create_agent_rejects_invalid_faq(faq: object) -> None:
    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Assistant",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "model_type": "openai",
            "created_by": "owner@example.com",
            "faq": faq,
        },
    )

    assert response.status_code == 422


def test_create_agent_accepts_inline_python_tool(monkeypatch) -> None:
    stored = agent_record()
    stored["tooling"] = [
        {
            "name": "doublePrice",
            "description": "Double a stock price.",
            "source_code": "def doublePrice(stock_price: float) -> float:\n    return stock_price * 2",
            "enabled": True,
        }
    ]
    monkeypatch.setattr("controllers.agents.create_agent", lambda values: stored)

    response = client.post(
        "/api/agents",
        json={
            "agent_name": "Stock Analyst",
            "owner_email": "owner@example.com",
            "model_id": "gpt-5.4-mini",
            "model_type": "openai",
            "created_by": "owner@example.com",
            "tooling": stored["tooling"],
        },
    )

    assert response.status_code == 201
    assert response.json()["tooling"][0]["name"] == "doublePrice"


def test_list_agents_normalizes_legacy_string_tooling(monkeypatch, caplog) -> None:
    legacy_agent = agent_record()
    legacy_agent["tooling"] = ["legacy-tool-id"]
    monkeypatch.setattr("controllers.agents.list_agents", lambda: [legacy_agent])

    with caplog.at_level(logging.WARNING, logger="ai_harness.agent_repository"):
        decoded = _decode_agent(legacy_agent)

    assert decoded is not None
    assert decoded["tooling"] == []
    assert "legacy-tool-id" not in caplog.text

    response = client.get("/api/agents")

    assert response.status_code == 200
    assert response.json()[0]["tooling"] == []


def test_decode_agent_preserves_valid_tooling() -> None:
    stored_agent = agent_record()
    stored_agent["tooling"] = [{
        "name": "doublePrice",
        "description": "Double a stock price.",
        "source_code": "def doublePrice(stock_price: float) -> float:\n    return stock_price * 2",
        "enabled": True,
    }]

    decoded = _decode_agent(stored_agent)

    assert decoded is not None
    assert decoded["tooling"] == stored_agent["tooling"]


def test_decode_agent_normalizes_faq_json_and_null() -> None:
    stored_agent = agent_record()
    stored_agent["faq"] = '{"Question": "Answer"}'

    decoded = _decode_agent(stored_agent)

    assert decoded is not None
    assert decoded["faq"] == {"Question": "Answer"}

    stored_agent["faq"] = None
    decoded = _decode_agent(stored_agent)

    assert decoded is not None
    assert decoded["faq"] == {}


def test_decode_agent_normalizes_null_description_to_empty_string() -> None:
    stored_agent = agent_record()
    stored_agent["description"] = None

    decoded = _decode_agent(stored_agent)

    assert decoded is not None
    assert decoded["description"] == ""


def test_agent_endpoints_return_empty_string_for_null_description(monkeypatch) -> None:
    stored = agent_record()
    stored["description"] = None
    decoded = _decode_agent(stored)
    assert decoded is not None
    monkeypatch.setattr("controllers.agents.get_agent", lambda agent_id: decoded)
    monkeypatch.setattr("controllers.agents.list_agents", lambda: [decoded])

    detail_response = client.get(f"/api/agents/{decoded['agent_id']}")
    list_response = client.get("/api/agents")

    assert detail_response.status_code == 200
    assert detail_response.json()["description"] == ""
    assert list_response.status_code == 200
    assert list_response.json()[0]["description"] == ""


def test_serialize_agent_values_preserves_null_faq_as_sql_null() -> None:
    serialized = _serialize_agent_values({"faq": None, "guardrails": None})

    assert serialized["faq"] is None
    assert serialized["guardrails"] == "null"


def test_update_agent_returns_not_found(monkeypatch) -> None:
    monkeypatch.setattr("controllers.agents.update_agent", lambda agent_id, values: None)

    response = client.patch("/api/agents/missing", json={"agent_name": "Updated"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Agent not found"}


def test_repository_update_agent_is_idempotent_when_values_are_unchanged(monkeypatch) -> None:
    existing = agent_record()
    queries: list[tuple[str, object]] = []
    commits: list[bool] = []

    class Cursor:
        def execute(self, query: str, params: object) -> None:
            queries.append((query, params))

        def fetchone(self) -> tuple[int]:
            return (1,)

        def close(self) -> None:
            return None

    class Connection:
        def cursor(self) -> Cursor:
            return Cursor()

        def commit(self) -> None:
            commits.append(True)

        def close(self) -> None:
            return None

    class Pool:
        def get_connection(self) -> Connection:
            return Connection()

    monkeypatch.setattr("services.agent_repository.get_agent", lambda agent_id: existing)
    monkeypatch.setattr("services.agent_repository.get_connection_pool", lambda: Pool())
    monkeypatch.setattr("services.agent_repository.validate_tool_definitions", lambda tools: None)

    result = update_stored_agent(str(existing["agent_id"]), {"agent_name": existing["agent_name"]})

    assert result == existing
    assert commits == [True]
    assert "FOR UPDATE" in queries[0][0]
    assert "isActive = 'Y'" in queries[1][0]


def test_repository_update_agent_stops_if_agent_became_inactive(monkeypatch) -> None:
    existing = agent_record()
    queries: list[str] = []
    commits: list[bool] = []

    class Cursor:
        def execute(self, query: str, params: object) -> None:
            queries.append(query)

        def fetchone(self) -> None:
            return None

        def close(self) -> None:
            return None

    class Connection:
        def cursor(self) -> Cursor:
            return Cursor()

        def commit(self) -> None:
            commits.append(True)

        def close(self) -> None:
            return None

    class Pool:
        def get_connection(self) -> Connection:
            return Connection()

    monkeypatch.setattr("services.agent_repository.get_agent", lambda agent_id: existing)
    monkeypatch.setattr("services.agent_repository.get_connection_pool", lambda: Pool())
    monkeypatch.setattr("services.agent_repository.validate_tool_definitions", lambda tools: None)

    result = update_stored_agent(str(existing["agent_id"]), {"agent_name": "Updated"})

    assert result is None
    assert len(queries) == 1
    assert "FOR UPDATE" in queries[0]
    assert commits == []


def test_update_agent_persists_initiative_id(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def update(agent_id: str, values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored.update(values)
        return stored

    monkeypatch.setattr("controllers.agents.update_agent", update)

    response = client.patch(
        "/api/agents/11111111-1111-1111-1111-111111111111",
        json={"initiative_id": "initiative-456"},
    )

    assert response.status_code == 200
    assert response.json()["initiative_id"] == "initiative-456"
    assert captured["initiative_id"] == "initiative-456"


def test_update_agent_persists_faq(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def update(agent_id: str, values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored.update(values)
        return stored

    monkeypatch.setattr("controllers.agents.update_agent", update)

    faq = {"How does this work?": "It is stored as agent metadata."}
    response = client.patch(
        "/api/agents/11111111-1111-1111-1111-111111111111",
        json={"faq": faq},
    )

    assert response.status_code == 200
    assert response.json()["faq"] == faq
    assert captured["faq"] == faq


def test_update_agent_clears_faq_with_null(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def update(agent_id: str, values: dict[str, object]) -> dict[str, object]:
        captured.update(values)
        stored = agent_record()
        stored["faq"] = {}
        return stored

    monkeypatch.setattr("controllers.agents.update_agent", update)

    response = client.patch(
        "/api/agents/11111111-1111-1111-1111-111111111111",
        json={"faq": None},
    )

    assert response.status_code == 200
    assert captured["faq"] is None
    assert response.json()["faq"] == {}


def test_delete_agent_soft_deactivates(monkeypatch) -> None:
    monkeypatch.setattr("controllers.agents.deactivate_agent", lambda agent_id: agent_id == "agent-1")

    assert client.delete("/api/agents/agent-1").status_code == 204
    missing = client.delete("/api/agents/missing")
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Agent not found"


def test_delete_tool_soft_deactivates(monkeypatch) -> None:
    monkeypatch.setattr("controllers.tool_library.deactivate_tool", lambda tool_id: tool_id == "tool-1")

    assert client.delete("/api/tools/tool-1").status_code == 204
    assert client.delete("/api/tools/missing").status_code == 404


def test_delete_mcp_source_soft_deactivates_source_and_tools(monkeypatch) -> None:
    monkeypatch.setattr("controllers.tool_library.deactivate_source", lambda source_id: source_id == "source-1")

    assert client.delete("/api/tool-sources/source-1").status_code == 204
    assert client.delete("/api/tool-sources/missing").status_code == 404


def test_tool_library_lists_persisted_definitions(monkeypatch) -> None:
    monkeypatch.setattr("controllers.tool_library.list_tools", lambda **filters: [{
        "tool_definition_id": "tool-1", "source_id": "source-1", "external_name": "find_invoices",
        "display_name": "Find invoices", "description": "Find overdue invoices.",
        "connection_type": "mcp", "input_schema": {"type": "object"}, "output_schema": None,
        "version": None, "category": "Finance", "effect": "read", "effect_source": "provider_declared",
        "status": "available", "examples": [], "output_preview": None, "source_code": None,
        "enabled": True, "source_name": "SMB Sandbox", "owner_email": "owner@example.com", "endpoint": "http://sandbox/mcp",
    }])

    response = client.get("/api/tools?connection=mcp&effect=read")

    assert response.status_code == 200
    assert response.json()[0]["display_name"] == "Find invoices"


def test_inline_tool_preview_endpoint_uses_unsaved_definition(monkeypatch) -> None:
    captured: dict[str, object] = {}

    async def preview(name: str, description: str, source_code: str,
                      arguments: dict[str, object]) -> dict[str, object]:
        captured.update({"name": name, "description": description, "source_code": source_code, "arguments": arguments})
        return {"outcome": "success", "output": 5, "error": None, "duration_ms": 2}

    monkeypatch.setattr("controllers.tool_library.test_inline_tool", preview)
    response = client.post("/api/tools/inline/test", json={
        "name": "add", "description": "Add values", "source_code": "def add(a, b): return a + b",
        "arguments": {"a": 2, "b": 3},
    })

    assert response.status_code == 200
    assert response.json()["output"] == 5
    assert captured["name"] == "add"
    assert captured["arguments"] == {"a": 2, "b": 3}


def test_inline_tool_preview_executes_without_persistence() -> None:
    result = asyncio.run(execute_inline_tool(
        "add", "Add values", "def add(a: int, b: int) -> int:\n    return a + b", {"a": 4, "b": 6},
    ))

    assert result["outcome"] == "success"
    assert result["output"] == 10
    assert "execution_id" not in result


def test_inline_tool_preview_returns_validation_error() -> None:
    result = asyncio.run(execute_inline_tool(
        "expected_name", "Invalid tool", "def another_name():\n    return 1", {},
    ))

    assert result["outcome"] == "error"
    assert "callable named 'expected_name'" in str(result["error"])


def test_inline_tool_preview_reports_runtime_errors() -> None:
    result = asyncio.run(execute_inline_tool(
        "explode", "Raise an error", "def explode():\n    raise RuntimeError('preview failed')", {},
    ))

    assert result["outcome"] == "error"
    assert result["error"] == "RuntimeError: preview failed"


def test_inline_tool_preview_truncates_large_output() -> None:
    result = asyncio.run(execute_inline_tool(
        "large", "Return a large payload", "def large():\n    return 'x' * 21000", {},
    ))

    assert result["outcome"] == "success"
    assert result["output"]["truncated"] is True
    assert len(result["output"]["preview"]) == 19000


def test_mcp_registration_is_saved_when_discovery_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr("controllers.tool_library.create_source", lambda values: {
        "source_id": "source-1", **values, "source_type": "mcp", "transport": "streamable_http",
        "status": "unavailable", "tool_count": 0,
    })

    async def unavailable(source_id: str) -> dict[str, object]:
        return {"source_id": source_id, "status": "unavailable", "tool_count": 0, "error": "ConnectionError", "duration_ms": 12}

    monkeypatch.setattr("controllers.tool_library.discover_source", unavailable)
    response = client.post("/api/tool-sources/mcp", json={
        "name": "SMB Sandbox", "description": "Invoice tools", "endpoint": "http://sandbox/mcp", "owner_email": "owner@example.com",
    })

    assert response.status_code == 201
    assert response.json()["source_id"] == "source-1"
    assert response.json()["test"]["status"] == "unavailable"


def test_mcp_source_update_saves_and_rediscovers_only_requested_source(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def update(source_id: str, values: dict[str, object]) -> dict[str, object]:
        captured.update({"updated_source_id": source_id, "values": values})
        return {"source_id": source_id, "source_type": "mcp", **values, "owner_email": "owner@example.com"}

    async def discover(source_id: str) -> dict[str, object]:
        captured["discovered_source_id"] = source_id
        return {"source_id": source_id, "status": "available", "tool_count": 2, "error": None, "duration_ms": 8}

    monkeypatch.setattr("controllers.tool_library.update_source", update)
    monkeypatch.setattr("controllers.tool_library.discover_source", discover)

    response = client.patch("/api/tool-sources/source-1", json={
        "name": "Updated server", "description": "Updated description", "endpoint": "https://updated.example.com/mcp",
    })

    assert response.status_code == 200
    assert captured["updated_source_id"] == "source-1"
    assert captured["discovered_source_id"] == "source-1"
    assert response.json()["test"]["tool_count"] == 2


def test_mcp_source_update_returns_not_found(monkeypatch) -> None:
    monkeypatch.setattr("controllers.tool_library.update_source", lambda source_id, values: None)

    response = client.patch("/api/tool-sources/missing", json={
        "name": "Missing", "description": None, "endpoint": "https://missing.example.com/mcp",
    })

    assert response.status_code == 404


def test_mcp_source_test_targets_requested_source(monkeypatch) -> None:
    captured: list[str] = []

    async def discover(source_id: str) -> dict[str, object]:
        captured.append(source_id)
        return {"source_id": source_id, "status": "available", "tool_count": 1, "error": None, "duration_ms": 4}

    monkeypatch.setattr("controllers.tool_library.discover_source", discover)

    response = client.post("/api/tool-sources/source-2/test")

    assert response.status_code == 200
    assert captured == ["source-2"]


def _install_tool_execution_fakes(monkeypatch, captured: list[tuple[object, ...]]) -> None:
    class Cursor:
        def execute(self, query: str, params: tuple[object, ...]) -> None:
            captured.append(params)

        def close(self) -> None:
            return None

    class Connection:
        def cursor(self):
            return Cursor()

        def commit(self) -> None:
            return None

        def close(self) -> None:
            return None

    class Pool:
        def get_connection(self):
            return Connection()

    monkeypatch.setattr("services.tool_library.get_tool", lambda tool_id: {
        "tool_definition_id": tool_id, "connection_type": "mcp", "endpoint": "https://example.test/mcp",
        "external_name": "cm_get_equity_stocks", "description": "Get equities",
    })
    monkeypatch.setattr("services.tool_library.get_connection_pool", lambda: Pool())


def test_mcp_tool_execution_unwraps_task_group_error(monkeypatch) -> None:
    captured: list[tuple[object, ...]] = []

    async def failing_call(endpoint: str, name: str, arguments: dict[str, object]):
        raise ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError("upstream service unavailable")])

    _install_tool_execution_fakes(monkeypatch, captured)
    monkeypatch.setattr("services.tool_library.call_mcp_tool", failing_call)
    result = asyncio.run(execute_library_tool("tool-1", {"symbolFilter": "TCS", "limit": 50}, "owner@example.com"))

    assert result["outcome"] == "error"
    assert result["error"] == "RuntimeError: upstream service unavailable"
    assert "ExceptionGroup" not in result["error"]
    assert captured[-1][4] == "error"


def test_mcp_tool_execution_honors_error_result(monkeypatch) -> None:
    captured: list[tuple[object, ...]] = []

    class Result:
        is_error = True

        def model_dump(self, *, mode: str) -> dict[str, object]:
            return {"content": [{"type": "text", "text": "Invalid symbol filter"}], "is_error": True}

    async def error_call(endpoint: str, name: str, arguments: dict[str, object]):
        return Result()

    _install_tool_execution_fakes(monkeypatch, captured)
    monkeypatch.setattr("services.tool_library.call_mcp_tool", error_call)
    result = asyncio.run(execute_library_tool("tool-1", {"symbolFilter": "TCS", "limit": 50}, "owner@example.com"))

    assert result["outcome"] == "error"
    assert result["error"] == "Invalid symbol filter"
    assert result["output"]["is_error"] is True
    assert captured[-1][4] == "error"


def test_mcp_tool_execution_passes_endpoint_and_preserves_arguments(monkeypatch) -> None:
    captured: list[tuple[object, ...]] = []
    events: list[object] = []
    arguments = {"symbolFilter": "TCS", "limit": 50}

    class Result:
        is_error = False

        def model_dump(self, *, mode: str) -> dict[str, object]:
            return {"content": [{"type": "text", "text": "TCS"}], "is_error": False}

    async def successful_call(endpoint: str, name: str, received: dict[str, object]):
        events.append((endpoint, name, received))
        return Result()

    _install_tool_execution_fakes(monkeypatch, captured)
    monkeypatch.setattr("services.tool_library.call_mcp_tool", successful_call)
    result = asyncio.run(execute_library_tool("tool-1", arguments, "owner@example.com"))

    assert result["outcome"] == "success"
    assert events == [("https://example.test/mcp", "cm_get_equity_stocks", arguments)]
    assert json.loads(captured[-1][2]) == arguments


def test_mcp_call_uses_metadata_session_then_fresh_execution_session(monkeypatch) -> None:
    events: list[object] = []
    arguments = {"symbolFilter": "TCS", "limit": 50}

    class Result:
        pass

    class Client:
        def __init__(self, role: str) -> None:
            self.role = role

        async def __aenter__(self):
            events.append((self.role, "enter"))
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            events.append((self.role, "exit"))
            return False

        async def list_tools(self, *, cache_mode: str = "use"):
            events.append((self.role, "list_tools"))
            return SimpleNamespace(tools=[])

        async def call_tool(self, name: str, received: dict[str, object]):
            events.append((self.role, "call_tool", name, received))
            return Result()

    clients = iter([Client("metadata"), Client("execution")])
    monkeypatch.setattr("services.mcp_client.create_mcp_client", lambda endpoint: next(clients))

    result = asyncio.run(execute_mcp_call("https://mcp.nseindia.in/cmmkt/mcp", "cm_get_equity_stocks", arguments))

    assert isinstance(result, Result)
    assert events == [
        ("metadata", "enter"),
        ("metadata", "list_tools"),
        ("metadata", "exit"),
        ("execution", "enter"),
        ("execution", "list_tools"),
        ("execution", "call_tool", "cm_get_equity_stocks", arguments),
        ("execution", "exit"),
    ]


def test_mcp_call_reconnects_when_metadata_session_is_terminated(monkeypatch) -> None:
    events: list[object] = []

    class MCPError(Exception):
        pass

    class Result:
        pass

    class Client:
        def __init__(self, role: str, *, fail: bool = False) -> None:
            self.role = role
            self.fail = fail

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def list_tools(self, *, cache_mode: str = "use"):
            events.append((self.role, "list_tools"))
            if self.fail:
                raise ExceptionGroup("transport", [MCPError("Session terminated")])
            return SimpleNamespace(tools=[])

        async def call_tool(self, name: str, arguments: dict[str, object]):
            events.append((self.role, "call_tool"))
            return Result()

    clients = iter([
        Client("metadata-1", fail=True),
        Client("metadata-2"),
        Client("execution"),
    ])

    async def no_delay(seconds: float) -> None:
        return None

    monkeypatch.setattr("services.mcp_client.create_mcp_client", lambda endpoint: next(clients))
    monkeypatch.setattr("services.mcp_client.asyncio.sleep", no_delay)

    result = asyncio.run(execute_mcp_call("https://mcp.nseindia.in/cmmkt/mcp", "cm_get_equity_stocks", {}))

    assert isinstance(result, Result)
    assert events == [
        ("metadata-1", "list_tools"),
        ("metadata-2", "list_tools"),
        ("execution", "list_tools"),
        ("execution", "call_tool"),
    ]


def test_mcp_discovery_serializes_tool_schema_by_alias(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeTool:
        def model_dump(self, *, mode: str, by_alias: bool) -> dict[str, object]:
            assert mode == "json"
            assert by_alias is True
            return {
                "name": "search_messages", "description": "Search Microsoft messages.",
                "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
                "outputSchema": {"type": "object"},
            }

    async def fake_list_tools(endpoint: str, *, refresh: bool) -> SimpleNamespace:
        captured.update({"endpoint": endpoint, "refresh": refresh})
        return SimpleNamespace(tools=[FakeTool()])

    monkeypatch.setattr("services.tool_library.list_mcp_tools", fake_list_tools)
    monkeypatch.setattr("services.tool_library._get_source", lambda source_id: {"source_id": source_id, "endpoint": "https://microsoft.example.test/mcp"})
    monkeypatch.setattr("services.tool_library._save_discovery", lambda source_id, tools, error, **kwargs: captured.update({"tools": tools, "error": error}))

    result = asyncio.run(discover_source("source-1"))

    assert result["status"] == "available"
    assert captured["error"] is None
    assert captured["endpoint"] == "https://microsoft.example.test/mcp"
    assert captured["refresh"] is True
    assert captured["tools"][0]["inputSchema"]["required"] == ["query"]


def test_conversation_runtime_prefers_refreshed_mcp_schema_and_binding_settings(monkeypatch) -> None:
    from services.conversation_agent import ConversationAgentCache

    captured: dict[str, object] = {}
    monkeypatch.setattr("services.conversation_agent.get_config", lambda: SimpleNamespace(chat_history_message_limit=10))
    monkeypatch.setattr("services.conversation_agent.get_session_history", lambda *args: [])
    monkeypatch.setattr("services.conversation_agent.get_model_execution", lambda *args: object())
    monkeypatch.setattr("services.tool_library.get_tools_by_ids", lambda ids: [{
        "tool_definition_id": "tool-1", "external_name": "search_messages", "description": "Current description",
        "connection_type": "mcp", "endpoint": "https://microsoft.example.test/mcp", "status": "available",
        "source_status": "available", "enabled": True,
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    }])
    monkeypatch.setattr("services.conversation_agent.build_langchain_tools", lambda records: captured.update({"records": records}) or [object()])
    agent = agent_record()
    agent["tooling"] = [{
        "name": "search_messages", "description": "Stale description", "source_code": "", "connection_type": "mcp",
        "tool_definition_id": "tool-1", "enabled": False, "approval_policy": "ask", "defaults": {"limit": 5},
        "allowed_scope": {"mailbox": "current"}, "input_schema": {},
    }]

    runtime = ConversationAgentCache()._create_runtime_agent(agent, "session-1")
    record = captured["records"][0]

    assert record["input_schema"]["required"] == ["query"]
    assert record["description"] == "Current description"
    assert record["enabled"] is False
    assert record["approval_policy"] == "ask"
    assert record["defaults"] == {"limit": 5}
    assert runtime.system_prompts[-1].startswith("When a tool is relevant")


def test_agent_accepts_non_executable_mcp_tool_snapshot(monkeypatch) -> None:
    stored = agent_record()
    stored["tooling"] = [{
        "name": "find_invoices", "description": "Find overdue invoices.", "source_code": "", "enabled": True,
        "connection_type": "mcp", "tool_definition_id": "tool-1", "source_id": "source-1",
        "input_schema": {"type": "object"}, "category": "Finance", "effect": "read",
    }]
    monkeypatch.setattr("controllers.agents.create_agent", lambda values: stored)

    response = client.post("/api/agents", json={
        "agent_name": "Invoice Assistant", "owner_email": "owner@example.com", "model_id": "gpt-5.4-mini",
        "model_type": "openai", "created_by": "owner@example.com", "tooling": stored["tooling"],
    })

    assert response.status_code == 201
    assert response.json()["tooling"][0]["connection_type"] == "mcp"
    assert build_langchain_tools(stored["tooling"]) == []


def test_available_mcp_tool_executes_with_defaults(monkeypatch) -> None:
    calls: list[tuple[str, str, dict[str, object]]] = []

    class FakeResult:
        def model_dump(self, *, mode: str) -> dict[str, object]:
            assert mode == "json"
            return {"content": [{"type": "text", "text": "sunny"}], "isError": False}

    async def fake_call(endpoint: str, name: str, arguments: dict[str, object]) -> FakeResult:
        calls.append((endpoint, name, arguments))
        return FakeResult()

    monkeypatch.setattr("services.tool_runtime.call_mcp_tool", fake_call)
    tool = build_langchain_tools([{
        "name": "weather", "external_name": "get_weather", "description": "Get weather.",
        "connection_type": "mcp", "enabled": True, "approval_policy": "automatic",
        "endpoint": "https://mcp.example.test/tools", "status": "available", "source_status": "available",
        "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        "defaults": {"units": "metric"},
    }])[0]

    result = asyncio.run(tool.ainvoke({"city": "London"}))

    assert tool.name == "get_weather"
    assert calls == [(
        "https://mcp.example.test/tools",
        "get_weather",
        {"units": "metric", "city": "London"},
    )]
    assert result["isError"] is False


def test_shared_mcp_client_disables_delete_termination(monkeypatch) -> None:
    captured: dict[str, object] = {"caches": []}

    def fake_transport(endpoint: str, *, terminate_on_close: bool) -> object:
        captured.update({"endpoint": endpoint, "terminate_on_close": terminate_on_close})
        return object()

    class FakeClient:
        def __init__(self, transport: object, *, cache: object) -> None:
            captured["transport"] = transport
            captured["caches"].append(cache)

    monkeypatch.setattr("mcp.Client", FakeClient)
    monkeypatch.setattr("mcp.client.streamable_http.streamable_http_client", fake_transport)

    from services.mcp_client import create_mcp_client

    create_mcp_client("https://learn.microsoft.com/api/mcp")
    create_mcp_client("https://learn.microsoft.com/api/mcp")

    assert captured["endpoint"] == "https://learn.microsoft.com/api/mcp"
    assert captured["terminate_on_close"] is False
    first_cache, second_cache = captured["caches"]
    assert first_cache.store is second_cache.store
    assert first_cache.store._max_entries == 256
    assert first_cache.partition == "anonymous"
    assert first_cache.target_id == "https://learn.microsoft.com/api/mcp"
    assert first_cache.default_ttl_ms == 300_000


def test_post_only_mcp_filter_hides_only_known_compatibility_noise() -> None:
    from services.mcp_client import _PostOnlyMcpNoiseFilter

    noise_filter = _PostOnlyMcpNoiseFilter()

    def record(logger: str, message: str) -> logging.LogRecord:
        return logging.LogRecord(logger, logging.INFO, __file__, 1, message, (), None)

    assert noise_filter.filter(record(
        "httpx2",
        'HTTP Request: GET https://learn.microsoft.com/api/mcp "HTTP/1.1 405 Method Not Allowed"',
    )) is False
    assert noise_filter.filter(record(
        "mcp.client.streamable_http",
        "GET stream disconnected, reconnecting in 1000ms...",
    )) is False
    assert noise_filter.filter(record(
        "httpx2",
        'HTTP Request: POST https://learn.microsoft.com/api/mcp "HTTP/1.1 500 Internal Server Error"',
    )) is True


def test_chat_event_sink_promotes_tool_execution_fields() -> None:
    sink = ChatEventSink()
    sink({
        "event": "runtime.tool.invoke.end", "tool_name": "get_weather", "tool_call_id": "call-1",
        "arguments": {"city": "London"}, "result": {"temperature": 18}, "duration_ms": 12.5,
    })

    event = sink.queue.get_nowait()

    assert event["type"] == "runtime.tool.invoke.end"
    assert event["tool_name"] == "get_weather"
    assert event["arguments"] == {"city": "London"}
    assert event["result"] == {"temperature": 18}
    assert event["duration_ms"] == 12.5
    assert event["payload"]["tool_call_id"] == "call-1"


def test_model_execution_logs_provider_failure_without_prompt(monkeypatch, caplog) -> None:
    class FailingChatModel:
        async def ainvoke(self, messages: list[object], config: object | None = None) -> None:
            raise RuntimeError("provider unavailable")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    executor = ModelExecution(chat_model=FailingChatModel())

    with caplog.at_level(logging.ERROR, logger="ai_harness.model_execution"):
        with pytest.raises(ModelExecutionError):
            asyncio.run(executor.execute("sensitive prompt"))

    assert "Model request failed" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "sensitive prompt" not in caplog.text
    assert "test-key" not in caplog.text


def test_model_execution_logs_missing_api_key(monkeypatch, caplog) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with caplog.at_level(logging.ERROR, logger="ai_harness.model_execution"):
        with pytest.raises(ModelNotConfiguredError):
            ModelExecution(chat_model=object())

    assert "OPENAI_API_KEY is missing" in caplog.text


def test_ollama_model_execution_returns_local_model_response() -> None:
    class FakeChatModel:
        async def ainvoke(
            self, messages: list[object], config: object | None = None
        ) -> SimpleNamespace:
            assert messages[-1].content == "Hello"
            return SimpleNamespace(content="Hello from Ollama")

    response = asyncio.run(OllamaModelExecution(chat_model=FakeChatModel()).execute("Hello"))

    assert response == "Hello from Ollama"


def test_ollama_model_execution_logs_provider_failure(caplog) -> None:
    class FailingChatModel:
        async def ainvoke(self, messages: list[object]) -> None:
            raise ConnectionError("Ollama unavailable")

    executor = OllamaModelExecution(chat_model=FailingChatModel())

    with caplog.at_level(logging.ERROR, logger="ai_harness.ollama_model_execution"):
        with pytest.raises(ModelExecutionError):
            asyncio.run(executor.execute("sensitive prompt"))

    assert "Ollama model request failed" in caplog.text
    assert "sensitive prompt" not in caplog.text


def test_model_execution_factory_selects_ollama(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.model_execution.get_config",
        lambda: SimpleNamespace(chat_provider="ollama"),
    )
    monkeypatch.setattr(
        "services.ollama_model_execution.get_config",
        lambda: SimpleNamespace(ollama_model="llama3.2:3b"),
    )
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    get_model_execution.cache_clear()

    try:
        assert isinstance(get_model_execution(), OllamaModelExecution)
    finally:
        get_model_execution.cache_clear()


def test_model_execution_factory_selects_openai(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.model_execution.get_config",
        lambda: SimpleNamespace(chat_provider="openai", openai_model="gpt-5.4-mini"),
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    get_model_execution.cache_clear()

    try:
        assert isinstance(get_model_execution(), ModelExecution)
    finally:
        get_model_execution.cache_clear()


def test_model_execution_factory_passes_selected_openai_model(monkeypatch) -> None:
    captured: dict[str, str] = {}

    class FakeChatOpenAI:
        def __init__(self, *, model: str) -> None:
            captured["model"] = model

    monkeypatch.setattr("services.model_execution.ChatOpenAI", FakeChatOpenAI)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    get_model_execution.cache_clear()

    try:
        executor = get_model_execution("openai", "gpt-4.1-mini")
        assert isinstance(executor, ModelExecution)
        assert captured["model"] == "gpt-4.1-mini"
    finally:
        get_model_execution.cache_clear()


def test_stored_python_tool_builds_a_langchain_tool() -> None:
    record = {
        "name": "doublePrice",
        "description": "Double a supplied stock price.",
        "source_code": "def doublePrice(stock_price: float) -> float:\n    return stock_price * 2",
        "enabled": True,
    }

    tool = build_langchain_tools([record])[0]

    assert tool.invoke({"stock_price": 12.5}) == 25.0


def test_market_price_tool_uses_yahoo_chart_rest_api(monkeypatch) -> None:
    requested: dict[str, object] = {}

    class FakeResponse:
        def __enter__(self) -> io.StringIO:
            return io.StringIO(json.dumps({
                "chart": {"result": [{"meta": {"symbol": "AAPL", "regularMarketPrice": 210.5, "currency": "USD"}}]}
            }))

        def __exit__(self, *args: object) -> None:
            return None

    def fake_urlopen(request: object, timeout: int) -> FakeResponse:
        requested["url"] = getattr(request, "full_url")
        requested["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    source_code = '''def getMarketPrice(stock_symbol: str) -> dict[str, object]:
    import json
    from urllib.parse import quote
    from urllib.request import Request, urlopen

    symbol = stock_symbol.strip().upper()
    if not symbol:
        return {"error": "stock_symbol is required"}
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol, safe='')}?interval=1d&range=1d"
    try:
        with urlopen(Request(url), timeout=10) as response:
            result = json.load(response)["chart"]["result"][0]
        meta = result.get("meta", {})
        price = meta.get("regularMarketPrice")
        if price is None:
            return {"symbol": symbol, "error": "No market price was returned for this ticker"}
        return {"symbol": meta.get("symbol", symbol), "price": price, "currency": meta.get("currency")}
    except Exception as exc:
        return {"symbol": symbol, "error": f"Unable to retrieve market price: {type(exc).__name__}"}
'''
    tool = build_langchain_tools([{
        "name": "getMarketPrice", "description": "Return a market price.",
        "source_code": source_code, "enabled": True,
    }])[0]

    assert tool.invoke({"stock_symbol": "aapl"}) == {
        "symbol": "AAPL", "price": 210.5, "currency": "USD"
    }
    assert requested == {
        "url": "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
        "timeout": 10,
    }


def test_stock_price_seed_has_no_yfinance_dependency() -> None:
    seed = (Path(__file__).parents[1] / "resources" / "scripts" / "seed_stock_price_agent.sql").read_text()

    assert "yfinance" not in seed
    assert "query1.finance.yahoo.com/v8/finance/chart" in seed


def test_stored_python_tool_requires_declared_callable() -> None:
    with pytest.raises(ToolFunctionValidationError):
        validate_tool_definitions([
            {
                "name": "getMarketPrice",
                "description": "Return a price.",
                "source_code": "def another_tool() -> None:\n    pass",
                "enabled": True,
            }
        ])


def test_model_execution_runs_tool_call_then_returns_final_answer(monkeypatch, caplog) -> None:
    class FakeChatModel:
        def __init__(self) -> None:
            self.messages: list[list[object]] = []
            self.bound_tools: list[object] = []

        def bind_tools(self, tools: list[object]) -> "FakeChatModel":
            self.bound_tools = tools
            return self

        async def ainvoke(
            self, messages: list[object], config: object | None = None
        ) -> AIMessage:
            self.messages.append(messages)
            if len(self.messages) == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{"name": "doublePrice", "args": {"stock_price": 12.5}, "id": "call-1"}],
                )
            assert any(isinstance(message, ToolMessage) for message in messages)
            return AIMessage(content="The doubled price is 25.0.")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    tool = build_langchain_tools([
        {
            "name": "doublePrice", "description": "Double a price.",
            "source_code": "def doublePrice(stock_price: float) -> float:\n    return stock_price * 2",
            "enabled": True,
        }
    ])[0]
    chat_model = FakeChatModel()

    with caplog.at_level(logging.INFO, logger="ai_harness.langchain_trace"):
        response = asyncio.run(
            ModelExecution(chat_model=chat_model).execute_with_metadata(
                "Double 12.5", tools=[tool]
            )
        )

    assert response.text == "The doubled price is 25.0."
    assert chat_model.bound_tools == [tool]
    trace_events = [
        json.loads(record.message)
        for record in caplog.records
        if record.name == "ai_harness.langchain_trace"
    ]
    assert {event["event"] for event in trace_events}.issuperset(
        {"runtime.execution.start", "runtime.tool.invoke.start", "runtime.tool.invoke.end", "runtime.execution.end"}
    )
    assert all(event["trace_id"] == trace_events[0]["trace_id"] for event in trace_events)
    tool_start = next(event for event in trace_events if event["event"] == "runtime.tool.invoke.start")
    tool_end = next(event for event in trace_events if event["event"] == "runtime.tool.invoke.end")
    tool_message = next(event for event in trace_events if event["event"] == "runtime.tool.message.appended")
    assert tool_start["arguments"] == {"stock_price": 12.5}
    assert tool_end["result"] == 25.0
    assert tool_message["tool_name"] == "doublePrice"
    assert tool_message["arguments"] == {"stock_price": 12.5}
    assert tool_message["result"] == 25.0


def test_tool_loop_allows_ten_calls_then_a_final_response() -> None:
    calls: list[int] = []
    events: list[dict[str, object]] = []

    class Tool:
        name = "lookup"

        async def ainvoke(self, arguments: dict[str, int], config: object | None = None) -> int:
            calls.append(arguments["value"])
            return arguments["value"]

    class Model:
        invocation_count = 0

        async def ainvoke(self, messages: list[object], config: object | None = None) -> AIMessage:
            self.invocation_count += 1
            if self.invocation_count <= MAX_TOOL_CALLS:
                return AIMessage(content="", tool_calls=[{
                    "name": "lookup",
                    "args": {"value": self.invocation_count},
                    "id": f"call-{self.invocation_count}",
                }])
            assert isinstance(messages[-1], SystemMessage)
            assert "budget is exhausted" in str(messages[-1].content)
            return AIMessage(content="Final answer")

    response, _, _ = asyncio.run(invoke_model_with_tools(
        chat_model=Model(),
        messages=[HumanMessage(content="Use the tools")],
        tools=[Tool()],
        trace=LangChainTrace("openai", "test", events.append),
        logger=logging.getLogger("test.tool_loop"),
    ))

    assert response.content == "Final answer"
    assert calls == list(range(1, 11))
    assert any(event["event"] == "runtime.tool_call_limit.reached" for event in events)
    assert f"maximum budget of {MAX_TOOL_CALLS}" in TOOL_USE_SYSTEM_PROMPT
    assert "minimum number of tool calls" in TOOL_USE_SYSTEM_PROMPT


def test_tool_loop_rejects_an_over_budget_batch_atomically() -> None:
    calls: list[int] = []
    events: list[dict[str, object]] = []

    class Tool:
        name = "lookup"

        async def ainvoke(self, arguments: dict[str, int], config: object | None = None) -> int:
            calls.append(arguments["value"])
            return arguments["value"]

    class Model:
        async def ainvoke(self, messages: list[object], config: object | None = None) -> AIMessage:
            return AIMessage(content="", tool_calls=[
                {"name": "lookup", "args": {"value": 1}, "id": "call-1"},
                {"name": "lookup", "args": {"value": 2}, "id": "call-2"},
            ])

    with pytest.raises(RuntimeError, match="Tool call limit of 1 exceeded"):
        asyncio.run(invoke_model_with_tools(
            chat_model=Model(),
            messages=[HumanMessage(content="Use the tools")],
            tools=[Tool()],
            trace=LangChainTrace("openai", "test", events.append),
            logger=logging.getLogger("test.tool_loop"),
            max_tool_calls=1,
        ))

    assert calls == []
    limit_event = next(event for event in events if event["event"] == "runtime.tool_call_limit.exceeded")
    assert limit_event["tool_call_count"] == 0
    assert limit_event["requested_tool_calls"] == 2
    assert limit_event["max_tool_calls"] == 1


@pytest.mark.parametrize("tool_available", [False, True])
def test_failed_and_unavailable_tool_attempts_count_toward_limit(tool_available: bool) -> None:
    events: list[dict[str, object]] = []

    class FailingTool:
        name = "lookup"

        async def ainvoke(self, arguments: dict[str, object], config: object | None = None) -> None:
            raise RuntimeError("tool failed")

    class Model:
        invocation_count = 0

        async def ainvoke(self, messages: list[object], config: object | None = None) -> AIMessage:
            self.invocation_count += 1
            return AIMessage(content="", tool_calls=[{
                "name": "lookup",
                "args": {},
                "id": f"call-{self.invocation_count}",
            }])

    with pytest.raises(RuntimeError, match="Tool call limit of 1 exceeded"):
        asyncio.run(invoke_model_with_tools(
            chat_model=Model(),
            messages=[HumanMessage(content="Use the tool")],
            tools=[FailingTool()] if tool_available else [],
            trace=LangChainTrace("openai", "test", events.append),
            logger=logging.getLogger("test.tool_loop"),
            max_tool_calls=1,
        ))

    expected_event = "runtime.tool.invoke.error" if tool_available else "runtime.tool.invoke.unavailable"
    assert any(event["event"] == expected_event for event in events)
    limit_event = next(event for event in events if event["event"] == "runtime.tool_call_limit.exceeded")
    assert limit_event["tool_call_count"] == 1
