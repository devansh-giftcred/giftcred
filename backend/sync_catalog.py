#!/usr/bin/env python3
"""CLI entrypoint: authenticate with Woohoo Sandbox and sync catalog to PostgreSQL."""

import sys
from pathlib import Path

from config import get_settings
from database import get_session, init_db
from logger import get_logger, setup_logging
from woohoo_client import WoohooAuthError, WoohooAPIError, WoohooClient


def main() -> int:
    settings = get_settings()
    setup_logging(settings.log_level)
    logger = get_logger("sync_catalog")

    logger.info("Woohoo catalog sync starting")
    logger.info("Base URL: %s", settings.base_url)
    logger.info("Responses will be saved to: %s", Path(__file__).resolve().parent / "responses")

    try:
        init_db()
        client = WoohooClient(settings)

        with get_session() as session:
            stats = client.sync_catalog_to_db(session)

        print("\nSYNC SUMMARY")
        print(f"  Categories added:    {stats['categories_added']}")
        print(f"  Categories updated:  {stats['categories_updated']}")
        print(f"  Subcategories added:   {stats['subcategories_added']}")
        print(f"  Subcategories updated: {stats['subcategories_updated']}")
        logger.info("Catalog sync completed successfully")
        return 0

    except WoohooAuthError as exc:
        logger.error("Authentication failed: %s", exc)
        print("\nAUTHENTICATION FAILED")
        print(str(exc))
        print("Check the debug output above for HTTP status, headers, and response body.")
        return 1

    except WoohooAPIError as exc:
        logger.error("Catalog API error: %s", exc)
        print("\nCATALOG API FAILED")
        print(str(exc))
        return 1

    except Exception as exc:
        logger.exception("Unexpected error during catalog sync: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
