"""MySQL connection-pool configuration and readiness checks."""

from contextlib import closing
from functools import lru_cache
import logging

from mysql.connector import Error, pooling

from utils.config import DatabaseConfig, get_database_config


logger = logging.getLogger("ai_harness.database")


class DatabaseConfigurationError(Exception):
    """Raised when required database settings are not available."""


class DatabaseUnavailableError(Exception):
    """Raised when the database cannot service a request."""


@lru_cache
def get_connection_pool() -> pooling.MySQLConnectionPool:
    """Create a TLS-verified MySQL connection pool on first use."""
    config = get_database_config()

    try:
        return pooling.MySQLConnectionPool(
            pool_name="ai_harness_pool",
            pool_size=5,
            host=config.host,
            port=config.port,
            user=config.user,
            password=config.password,
            database=config.database,
            ssl_ca=str(config.ssl_ca),
            ssl_verify_cert=True,
            ssl_verify_identity=True,
            connection_timeout=10,
        )
    except Error as exc:
        logger.exception("MySQL connection pool initialization failed")
        raise DatabaseUnavailableError("MySQL pool initialization failed") from exc


def check_database_readiness() -> None:
    """Verify the configured MySQL database can execute a simple query."""
    try:
        with closing(get_connection_pool().get_connection()) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
    except DatabaseConfigurationError:
        logger.error("MySQL readiness check skipped because database configuration is missing")
        raise
    except Error as exc:
        logger.exception("MySQL readiness check failed")
        raise DatabaseUnavailableError("MySQL readiness check failed") from exc
    except DatabaseUnavailableError:
        raise

    logger.info("MySQL readiness check passed")
