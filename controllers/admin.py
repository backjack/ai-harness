"""Administrator-only application access management endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field, field_validator

from services.admin_access import (
    AdminUserAlreadyExistsError,
    LastAdministratorError,
    create_admin_user,
    list_admin_users,
    normalize_email,
    update_admin_user,
)
from services.auth import AuthenticatedUser, CurrentUser
from utils.database import DatabaseUnavailableError


router = APIRouter(prefix="/admin/users", tags=["administration"])


def require_admin(user: CurrentUser) -> AuthenticatedUser:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required",
        )
    return user


AdminUserIdentity = Annotated[AuthenticatedUser, Depends(require_admin)]


class AdminUserBase(BaseModel):
    emailid: str = Field(min_length=3, max_length=320)
    firstname: str = Field(min_length=1, max_length=255)
    last_name: str = Field(max_length=255)
    is_admin: bool = False
    is_disabled: bool = False

    @field_validator("emailid")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = normalize_email(value)
        if normalized.count("@") != 1 or " " in normalized:
            raise ValueError("A valid email address is required")
        local, domain = normalized.split("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("A valid email address is required")
        return normalized

    @field_validator("firstname")
    @classmethod
    def normalize_firstname(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Name is required")
        return normalized

    @field_validator("last_name")
    @classmethod
    def normalize_last_name(cls, value: str) -> str:
        return value.strip()


class AdminUserCreate(AdminUserBase):
    pass


class AdminUserUpdate(BaseModel):
    firstname: str | None = Field(default=None, min_length=1, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    is_admin: bool | None = None
    is_disabled: bool | None = None

    @field_validator("firstname")
    @classmethod
    def normalize_optional_firstname(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Name is required")
        return normalized

    @field_validator("last_name")
    @classmethod
    def normalize_optional_last_name(cls, value: str | None) -> str | None:
        return None if value is None else value.strip()


class AdminUserResponse(AdminUserBase):
    pass


def _database_error(exc: DatabaseUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Database service is unavailable",
    )


@router.get("", response_model=list[AdminUserResponse])
async def get_users(_: AdminUserIdentity) -> list[dict[str, Any]]:
    try:
        return list_admin_users()
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc


@router.post("", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def add_user(request: AdminUserCreate, _: AdminUserIdentity) -> dict[str, Any]:
    try:
        return create_admin_user(request.model_dump())
    except AdminUserAlreadyExistsError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User already has access") from exc
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc


@router.patch("/{emailid}", response_model=AdminUserResponse)
async def edit_user(
    emailid: Annotated[str, Path(min_length=3, max_length=320)],
    request: AdminUserUpdate,
    _: AdminUserIdentity,
) -> dict[str, Any]:
    try:
        user = update_admin_user(emailid, request.model_dump(exclude_unset=True, exclude_none=True))
    except LastAdministratorError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="At least one administrator is required") from exc
    except DatabaseUnavailableError as exc:
        raise _database_error(exc) from exc
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


