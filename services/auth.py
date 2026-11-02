"""Google OIDC token validation and authenticated request identity."""

import logging
import os
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.exceptions import GoogleAuthError
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from pydantic import BaseModel


logger = logging.getLogger("ai_harness.auth")
bearer_scheme = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    """Identity claims trusted after Google has validated the ID token."""

    sub: str
    email: str
    name: str
    picture: str | None = None


def get_google_client_id() -> str:
    """Return the configured Google web client ID."""
    return os.getenv("GOOGLE_CLIENT_ID", "").strip()


def is_auth_enabled() -> bool:
    """Return whether Google authentication should be enforced."""
    return os.getenv("AUTH_ENABLED", "true").strip().lower() not in {
        "false",
        "0",
        "no",
        "off",
    }


def get_static_user() -> AuthenticatedUser:
    """Build the configured identity used when authentication is disabled."""
    name = os.getenv("AUTH_STATIC_USER_NAME", "").strip()
    email = os.getenv("AUTH_STATIC_USER_EMAIL", "").strip()
    if not name or not email:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Static authentication user is not configured",
        )
    return AuthenticatedUser(
        sub="static-auth-user",
        email=email,
        name=name,
    )


def _verified_email(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == "true")


def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> AuthenticatedUser:
    """Validate a Google ID token and return its trusted user claims."""
    if not is_auth_enabled():
        user = get_static_user()
        logger.info(
            "Authenticated request mode=static method=%s path=%s email=%s name=%s sub=%s",
            request.method,
            request.url.path,
            user.email,
            user.name,
            user.sub,
        )
        return user

    client_id = get_google_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google authentication is not configured",
        )
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        claims = id_token.verify_oauth2_token(
            credentials.credentials,
            google_requests.Request(),
            client_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired Google ID token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except GoogleAuthError as exc:
        logger.exception("Google token validation service failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service is temporarily unavailable",
        ) from exc

    subject = str(claims.get("sub", "")).strip()
    email = str(claims.get("email", "")).strip()
    if not subject or not email or not _verified_email(claims.get("email_verified")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account does not have a verified email",
            headers={"WWW-Authenticate": "Bearer"},
        )

    name = str(claims.get("name", "")).strip() or email
    picture = str(claims.get("picture", "")).strip() or None
    user = AuthenticatedUser(sub=subject, email=email, name=name, picture=picture)
    logger.info(
        "Authenticated request mode=google method=%s path=%s email=%s name=%s sub=%s",
        request.method,
        request.url.path,
        user.email,
        user.name,
        user.sub,
    )
    return user


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
