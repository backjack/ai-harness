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
from services.agent_repository import _decode_agent
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
from langchain_core.messages import AIMessage, ToolMessage


client = TestClient(app)


def agent_record() -> dict[str, object]:
    return {
        "agent_id": "11111111-1111-1111-1111-111111111111",
        "agent_name": "Assistant",
        "description": "Helpful assistant.",
        "workflow": "Answer clearly.",
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
            "workflow": "Answer clearly.",
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
    assert captured["workflow"] == "Answer clearly."


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


def test_update_agent_returns_not_found(monkeypatch) -> None:
    monkeypatch.setattr("controllers.agents.update_agent", lambda agent_id, values: None)

    response = client.patch("/api/agents/missing", json={"agent_name": "Updated"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Agent not found"}


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
    assert tool_start["arguments"] == {"stock_price": 12.5}
    assert tool_end["result"] == 25.0
