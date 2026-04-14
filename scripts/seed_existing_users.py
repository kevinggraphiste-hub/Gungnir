"""
One-shot migration: seed per-user defaults for users created BEFORE the
bootstrap hook existed.

Run from the project root:
    python -m scripts.seed_existing_users

Idempotent — already-seeded users are left alone (backfill only adds new
defaults, never overwrites existing content).
"""
import asyncio
import logging
import sys
from pathlib import Path

# Ensure project root on sys.path when running as a script
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

from backend.core.db.engine import async_session
from backend.core.db.models import User
from backend.core.services.user_bootstrap import seed_user_defaults

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("seed_existing_users")


async def main():
    async with async_session() as session:
        result = await session.execute(select(User).order_by(User.id))
        users = result.scalars().all()
        log.info(f"Found {len(users)} users to backfill")

        for user in users:
            log.info(f"Seeding user {user.id} ({user.username})…")
            try:
                report = await seed_user_defaults(session, user.id)
                log.info(f"  → {report['seeded']}")
            except Exception as e:
                log.error(f"  ✗ failed: {e}")

        await session.commit()
        log.info("Done.")


if __name__ == "__main__":
    asyncio.run(main())
