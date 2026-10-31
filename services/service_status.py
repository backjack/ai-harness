"""Business logic for service-status endpoints."""

from utils.config import get_config


def get_service_identifier() -> dict[str, str]:
    """Return the configured service identifier."""
    return {"message": get_config().service_message}


def get_health_status() -> dict[str, str]:
    """Return the current availability status."""
    return {"status": "ok"}
