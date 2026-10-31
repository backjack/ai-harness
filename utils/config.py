"""Load and validate application configuration."""

from functools import lru_cache
import json
import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError


load_dotenv()

CONFIG_PATH = Path(__file__).resolve().parent.parent / "resources" / "config.json"
DEFAULT_MYSQL_SSL_CA = Path(__file__).resolve().parent.parent / "resources" / "certs" / "ca.pem"


class AppConfig(BaseModel):
    """Configuration required to construct the application."""

    title: str
    version: str
    service_message: str
    chat_provider: Literal["openai", "ollama"]
    openai_model: str
    ollama_model: str
    chat_history_message_limit: int = Field(default=20, ge=2)
    chat_session_cache_ttl_seconds: int = Field(default=1800, ge=1)
    chat_session_cache_max_size: int = Field(default=1000, ge=1)


class DatabaseConfig(BaseModel):
    """Environment-provided MySQL settings."""

    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    user: str = Field(min_length=1)
    password: str = Field(min_length=1)
    database: str = Field(min_length=1)
    ssl_ca: Path


@lru_cache
def get_config() -> AppConfig:
    """Read the repository-local JSON configuration once per process."""
    with CONFIG_PATH.open(encoding="utf-8") as config_file:
        return AppConfig.model_validate(json.load(config_file))


@lru_cache
def get_database_config() -> DatabaseConfig:
    """Load the database configuration without placing credentials in source code."""
    try:
        return DatabaseConfig(
            host=os.getenv("MYSQL_HOST", ""),
            port=os.getenv("MYSQL_PORT", ""),
            user=os.getenv("MYSQL_USER", ""),
            password=os.getenv("MYSQL_PASSWORD", ""),
            database=os.getenv("MYSQL_DATABASE", ""),
            ssl_ca=os.getenv("MYSQL_SSL_CA", str(DEFAULT_MYSQL_SSL_CA)),
        )
    except ValidationError as exc:
        from utils.database import DatabaseConfigurationError

        raise DatabaseConfigurationError("Database configuration is invalid") from exc
