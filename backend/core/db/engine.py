"""
Gungnir — Database engine (PostgreSQL + fallback SQLite for dev)
"""
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

# PostgreSQL by default, SQLite fallback for local dev
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///data/gungnir.db"
)

# asyncpg doesn't accept 'postgres://', must be 'postgresql+asyncpg://'
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Pool settings: recycle connections to avoid stale transaction state
_is_postgres = "postgresql" in DATABASE_URL or "asyncpg" in DATABASE_URL
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,  # Verify connection is alive before using it
    pool_recycle=300 if _is_postgres else -1,  # Recycle connections every 5min
    pool_size=5 if _is_postgres else 0,
)
async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_session() -> AsyncSession:
    async with async_session() as session:
        try:
            yield session
            # Commit if there are pending changes (no-op if nothing to commit)
            if session.is_modified or session.new or session.deleted:
                await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
