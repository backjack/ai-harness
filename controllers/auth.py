"""Authentication bootstrap and current-user endpoints."""

import logging

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel

from services.auth import AuthenticatedUser, CurrentUser, get_google_client_id, get_static_user, is_auth_enabled


router = APIRouter(prefix="/auth", tags=["authentication"])
logger = logging.getLogger("ai_harness.auth")


class AuthConfig(BaseModel):
    auth_enabled: bool
    client_id: str | None


@router.get("/config", response_model=AuthConfig)
async def auth_config() -> AuthConfig:
    """Return the public Google web client ID needed by the browser."""
    if not is_auth_enabled():
        get_static_user()
        return AuthConfig(auth_enabled=False, client_id=None)
    client_id = get_google_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google authentication is not configured",
        )
    return AuthConfig(auth_enabled=True, client_id=client_id)


@router.get("/me", response_model=AuthenticatedUser)
async def current_user(user: CurrentUser) -> AuthenticatedUser:
    """Validate the bearer token and return the current Google identity."""
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(user: CurrentUser) -> Response:
    """Audit a Google logout before the browser discards its ID token."""
    if not is_auth_enabled():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Logout is unavailable while static authentication is enabled",
        )
    logger.info(
        "User logout email=%s name=%s sub=%s",
        user.email,
        user.name,
        user.sub,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
