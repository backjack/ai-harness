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

from services.admin_access import get_or_create_admin_user, normalize_email
from utils.database import DatabaseUnavailableError


logger = logging.getLogger("ai_harness.auth")
bearer_scheme = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    """Identity claims trusted after Google has validated the ID token."""

    sub: str
    email: str
    name: str
    picture: str | None = None
    firstname: str
    last_name: str
    is_admin: bool


class AuthenticatedIdentity(BaseModel):
    """Identity established before application access is checked."""

    sub: str
    email: str
    name: str
    picture: str | None = None
    firstname: str
    last_name: str


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


def get_static_user() -> AuthenticatedIdentity:
    """Build the configured identity used when authentication is disabled."""
    name = os.getenv("AUTH_STATIC_USER_NAME", "").strip()
    email = os.getenv("AUTH_STATIC_USER_EMAIL", "").strip()
    if not name or not email:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Static authentication user is not configured",
        )
    firstname, last_name = _identity_names(name, email)
    return AuthenticatedIdentity(
        sub="static-auth-user",
        email=normalize_email(email),
        name=name,
        firstname=firstname,
        last_name=last_name,
    )


def _verified_email(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == "true")


def _identity_names(
    name: str, email: str, given_name: str = "", family_name: str = ""
) -> tuple[str, str]:
    """Derive registry names without requiring both OIDC name claims."""
    normalized_given = given_name.strip()
    normalized_family = family_name.strip()
    parts = name.strip().split(maxsplit=1)
    firstname = normalized_given or (parts[0] if parts else email.split("@", 1)[0])
    last_name = normalized_family or (parts[1] if len(parts) > 1 else "")
    return firstname, last_name


def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> AuthenticatedUser:
    """Validate a Google ID token and return its trusted user claims."""
    if not is_auth_enabled():
        identity = get_static_user()
        logger.info(
            "Authenticated request mode=static method=%s path=%s email=%s name=%s sub=%s",
            request.method,
            request.url.path,
            identity.email,
            identity.name,
            identity.sub,
        )
        return _authorize_identity(identity)

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
    email = normalize_email(str(claims.get("email", "")))
    if not subject or not email or not _verified_email(claims.get("email_verified")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account does not have a verified email",
            headers={"WWW-Authenticate": "Bearer"},
        )

    name = str(claims.get("name", "")).strip() or email
    picture = str(claims.get("picture", "")).strip() or None
    firstname, last_name = _identity_names(
        name,
        email,
        str(claims.get("given_name", "")),
        str(claims.get("family_name", "")),
    )
    identity = AuthenticatedIdentity(
        sub=subject,
        email=email,
        name=name,
        picture=picture,
        firstname=firstname,
        last_name=last_name,
    )
    logger.info(
        "Authenticated request mode=google method=%s path=%s email=%s name=%s sub=%s",
        request.method,
        request.url.path,
        identity.email,
        identity.name,
        identity.sub,
    )
    return _authorize_identity(identity)


def _authorize_identity(identity: AuthenticatedIdentity) -> AuthenticatedUser:
    """Register new identities and reject users explicitly disabled by an admin."""
    try:
        access = get_or_create_admin_user(
            identity.email, identity.firstname, identity.last_name
        )
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service is unavailable",
        ) from exc
    if bool(access["is_disabled"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access is disabled for email {identity.email}",
        )
    return AuthenticatedUser(
        sub=identity.sub,
        email=identity.email,
        name=identity.name,
        picture=identity.picture,
        firstname=str(access["firstname"]),
        last_name=str(access["last_name"]),
        is_admin=bool(access["is_admin"]),
    )


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
