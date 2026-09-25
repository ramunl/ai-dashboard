"""Entry point: python -m ai_dashboard."""

from __future__ import annotations

import logging
import sys

from aiohttp import web

from ai_dashboard.config import ConfigError, load_settings
from ai_dashboard.server import build_app


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        settings = load_settings()
    except ConfigError as error:
        logging.getLogger("ai_dashboard").error("Configuration error: %s", error)
        return 2
    web.run_app(
        build_app(settings),
        host=settings.host,
        port=settings.port,
        access_log=None,
        print=None,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
