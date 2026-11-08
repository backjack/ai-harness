import logging

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from controllers.agents import router as agents_router
from controllers.analytics import router as analytics_router
from controllers.auth import router as auth_router
from controllers.conversations import router as conversations_router
from controllers.service_status import router as service_status_router
from controllers.tool_library import router as tool_library_router
from services.auth import AuthenticatedUser, get_current_user


def auth_app() -> FastAPI:
    app = FastAPI()
    app.include_router(auth_router, prefix="/api")

    @app.get("/api/protected")
    def protected(user: AuthenticatedUser = Depends(get_current_user)) -> dict[str, str]:
        return {"email": user.email}

    return app


def business_app() -> FastAPI:
    app = FastAPI()
    app.include_router(service_status_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(
        agents_router,
        prefix="/api",
        dependencies=[Depends(get_current_user)],
    )
    app.include_router(
        analytics_router,
        prefix="/api",
        dependencies=[Depends(get_current_user)],
    )
    app.include_router(
        conversations_router,
        prefix="/api",
        dependencies=[Depends(get_current_user)],
    )
    app.include_router(
        tool_library_router,
        prefix="/api",
        dependencies=[Depends(get_current_user)],
    )
    return app


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/agents", None),
        ("GET", "/api/analytics", None),
        ("GET", "/api/conversations", None),
        ("GET", "/api/tools", None),
        ("GET", "/api/auth/me", None),
        ("POST", "/api/auth/logout", None),
        ("POST", "/api/chat", {"agent_id": "agent-1", "user_prompt": "Hello"}),
        ("POST", "/api/chat/stream", {"agent_id": "agent-1", "user_prompt": "Hello"}),
    ],
)
def test_all_business_apis_require_bearer_token(
    monkeypatch, method: str, path: str, body: dict[str, str] | None
) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")

    response = TestClient(business_app()).request(method, path, json=body)

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_bootstrap_and_operational_apis_remain_public(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")
    client = TestClient(business_app())

    assert client.get("/api/auth/config").status_code == 200
    assert client.get("/api/").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_openapi_marks_business_apis_as_bearer_protected() -> None:
    schema = business_app().openapi()
    protected_operations = [
        ("/api/agents", "get"),
        ("/api/analytics", "get"),
        ("/api/conversations", "get"),
        ("/api/tools", "get"),
        ("/api/chat", "post"),
        ("/api/chat/stream", "post"),
        ("/api/auth/me", "get"),
        ("/api/auth/logout", "post"),
    ]

    for path, method in protected_operations:
        assert schema["paths"][path][method]["security"] == [{"HTTPBearer": []}]

    assert "security" not in schema["paths"]["/api/auth/config"]["get"]
    assert "security" not in schema["paths"]["/api/health"]["get"]


def test_missing_bearer_token_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")
    response = TestClient(auth_app()).get("/api/protected")
    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
    assert TestClient(auth_app()).post("/api/auth/logout").status_code == 401


def test_valid_google_identity_is_returned_and_logged(monkeypatch, caplog) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")
    monkeypatch.setattr(
        "services.auth.id_token.verify_oauth2_token",
        lambda token, request, audience: {
            "sub": "google-user-1",
            "email": "neeraj@example.com",
            "email_verified": True,
            "name": "Neeraj Sharma",
            "picture": "https://example.com/photo.jpg",
        },
    )
    with caplog.at_level(logging.INFO, logger="ai_harness.auth"):
        response = TestClient(auth_app()).get(
            "/api/auth/me", headers={"Authorization": "Bearer valid-token"}
        )
    assert response.status_code == 200
    assert response.json() == {
        "sub": "google-user-1",
        "email": "neeraj@example.com",
        "name": "Neeraj Sharma",
        "picture": "https://example.com/photo.jpg",
    }
    assert "email=neeraj@example.com" in caplog.text
    assert "name=Neeraj Sharma" in caplog.text
    assert "valid-token" not in caplog.text


def test_google_logout_is_authenticated_and_audited(monkeypatch, caplog) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")
    monkeypatch.setattr(
        "services.auth.id_token.verify_oauth2_token",
        lambda *args, **kwargs: {
            "sub": "google-user-1",
            "email": "neeraj@example.com",
            "email_verified": True,
            "name": "Neeraj Sharma",
        },
    )

    with caplog.at_level(logging.INFO, logger="ai_harness.auth"):
        response = TestClient(auth_app()).post(
            "/api/auth/logout", headers={"Authorization": "Bearer valid-token"}
        )

    assert response.status_code == 204
    assert "User logout email=neeraj@example.com" in caplog.text
    assert "name=Neeraj Sharma" in caplog.text
    assert "valid-token" not in caplog.text


def test_invalid_google_token_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")

    def invalid(*args, **kwargs):
        raise ValueError("wrong audience")

    monkeypatch.setattr("services.auth.id_token.verify_oauth2_token", invalid)
    response = TestClient(auth_app()).get(
        "/api/protected", headers={"Authorization": "Bearer invalid-token"}
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired Google ID token"}


def test_unverified_email_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com")
    monkeypatch.setattr(
        "services.auth.id_token.verify_oauth2_token",
        lambda *args, **kwargs: {
            "sub": "google-user-1",
            "email": "neeraj@example.com",
            "email_verified": False,
        },
    )
    response = TestClient(auth_app()).get(
        "/api/protected", headers={"Authorization": "Bearer valid-token"}
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Google account does not have a verified email"}


def test_auth_config_requires_runtime_client_id(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    response = TestClient(auth_app()).get("/api/auth/config")
    assert response.status_code == 503


def test_static_auth_bypasses_google_and_returns_configured_user(monkeypatch, caplog) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("AUTH_STATIC_USER_NAME", "Neeraj Sharma")
    monkeypatch.setenv("AUTH_STATIC_USER_EMAIL", "neeraj.s1988@gmail.com")
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    client = TestClient(auth_app())

    config = client.get("/api/auth/config")
    with caplog.at_level(logging.INFO, logger="ai_harness.auth"):
        current_user = client.get("/api/auth/me")
        protected = client.get("/api/protected")

    assert config.status_code == 200
    assert config.json() == {"auth_enabled": False, "client_id": None}
    assert current_user.json() == {
        "sub": "static-auth-user",
        "email": "neeraj.s1988@gmail.com",
        "name": "Neeraj Sharma",
        "picture": None,
    }
    assert protected.json() == {"email": "neeraj.s1988@gmail.com"}
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 409
    assert logout.json() == {
        "detail": "Logout is unavailable while static authentication is enabled"
    }
    assert "mode=static" in caplog.text
    assert "email=neeraj.s1988@gmail.com" in caplog.text


def test_static_auth_requires_name_and_email(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "off")
    monkeypatch.delenv("AUTH_STATIC_USER_NAME", raising=False)
    monkeypatch.delenv("AUTH_STATIC_USER_EMAIL", raising=False)
    client = TestClient(auth_app())

    assert client.get("/api/auth/config").status_code == 503
    assert client.get("/api/protected").status_code == 503
