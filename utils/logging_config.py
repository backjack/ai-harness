"""Application logging configuration."""

import logging
import os


def configure_logging() -> None:
    """Configure console logging with an environment-selectable severity."""
    configured_level = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, configured_level, logging.INFO)

    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("ai_harness").setLevel(log_level)
