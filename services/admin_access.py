"""Database-backed application access and administrator management."""

from contextlib import closing
import logging
from typing import Any

from mysql.connector import Error, IntegrityError

from utils.database import DatabaseUnavailableError, get_connection_pool


logger = logging.getLogger("ai_harness.admin_access")


class AdminUserAlreadyExistsError(Exception):
    """Raised when an access record already exists for an email."""


class LastAdministratorError(Exception):
    """Raised when an operation would remove the final administrator."""


def normalize_email(email: str) -> str:
    """Return the canonical representation used for access lookups."""
    return email.strip().lower()


def get_admin_user(email: str) -> dict[str, Any] | None:
    """Return one registered user by email."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT emailid, firstname, last_name, is_admin, is_disabled "
                    "FROM admin_users WHERE emailid = %s",
                    (normalize_email(email),),
                )
                row = cursor.fetchone()
                if row is not None:
                    row["is_admin"] = bool(row["is_admin"])
                    row["is_disabled"] = bool(row["is_disabled"])
                return row
    except Error as exc:
        logger.exception("Application access lookup failed")
        raise DatabaseUnavailableError("Application access lookup failed") from exc


def list_admin_users() -> list[dict[str, Any]]:
    """Return every registered user in deterministic order."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor(dictionary=True)) as cursor:
                cursor.execute(
                    "SELECT emailid, firstname, last_name, is_admin, is_disabled "
                    "FROM admin_users ORDER BY firstname, last_name, emailid"
                )
                rows = cursor.fetchall()
                for row in rows:
                    row["is_admin"] = bool(row["is_admin"])
                    row["is_disabled"] = bool(row["is_disabled"])
                return rows
    except Error as exc:
        logger.exception("Application access list failed")
        raise DatabaseUnavailableError("Application access list failed") from exc


def create_admin_user(values: dict[str, Any]) -> dict[str, Any]:
    """Grant application access to one email."""
    email = normalize_email(str(values["emailid"]))
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "INSERT INTO admin_users (emailid, firstname, last_name, is_admin, is_disabled) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (
                        email,
                        values["firstname"],
                        values["last_name"],
                        bool(values["is_admin"]),
                        bool(values.get("is_disabled", False)),
                    ),
                )
            connection.commit()
    except IntegrityError as exc:
        raise AdminUserAlreadyExistsError(email) from exc
    except Error as exc:
        logger.exception("Application access creation failed")
        raise DatabaseUnavailableError("Application access creation failed") from exc
    return get_admin_user(email) or {}


def get_or_create_admin_user(
    email: str, firstname: str, last_name: str
) -> dict[str, Any]:
    """Return a registry row, inserting an enabled non-admin user when absent."""
    normalized_email = normalize_email(email)
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(
                    "INSERT INTO admin_users "
                    "(emailid, firstname, last_name, is_admin, is_disabled) "
                    "VALUES (%s, %s, %s, FALSE, FALSE) "
                    "ON DUPLICATE KEY UPDATE emailid = emailid",
                    (normalized_email, firstname.strip(), last_name.strip()),
                )
            connection.commit()
    except Error as exc:
        logger.exception("Authenticated user registration failed")
        raise DatabaseUnavailableError("Authenticated user registration failed") from exc
    return get_admin_user(normalized_email) or {}


def update_admin_user(email: str, values: dict[str, Any]) -> dict[str, Any] | None:
    """Update names or administrator status while retaining a final admin."""
    normalized_email = normalize_email(email)
    if not values:
        return get_admin_user(normalized_email)
    assignments = ", ".join(f"{column} = %s" for column in values)
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            try:
                with closing(connection.cursor(dictionary=True)) as cursor:
                    cursor.execute(
                        "SELECT emailid, is_admin, is_disabled FROM admin_users "
                        "WHERE emailid = %s FOR UPDATE",
                        (normalized_email,),
                    )
                    existing = cursor.fetchone()
                    if existing is None:
                        connection.rollback()
                        return None
                    removes_active_admin = (
                        bool(existing["is_admin"])
                        and not bool(existing["is_disabled"])
                        and (
                            values.get("is_admin") is False
                            or values.get("is_disabled") is True
                        )
                    )
                    if removes_active_admin:
                        cursor.execute(
                            "SELECT emailid FROM admin_users "
                            "WHERE is_admin = TRUE AND is_disabled = FALSE FOR UPDATE"
                        )
                        if len(cursor.fetchall()) <= 1:
                            raise LastAdministratorError(normalized_email)
                    cursor.execute(
                        f"UPDATE admin_users SET {assignments} WHERE emailid = %s",
                        [*values.values(), normalized_email],
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise
    except LastAdministratorError:
        raise
    except Error as exc:
        logger.exception("Application access update failed")
        raise DatabaseUnavailableError("Application access update failed") from exc
    return get_admin_user(normalized_email)


