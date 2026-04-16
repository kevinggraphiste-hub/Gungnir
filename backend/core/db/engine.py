"""
Gungnir — Database engine (PostgreSQL only, via asyncpg).

Dev local : `docker compose -f compose.dev.yml up -d` (expose Postgres 16 sur 5432),
puis DATABASE_URL=postgresql+asyncpg://gungnir:gungnir@localhost:5432/gungnir
Prod     : DATABASE_URL injectée par docker-compose.yml (service `db`).
"""
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL environment variable is required. "
        "For local dev, start Postgres with `docker compose -f compose.dev.yml up -d` "
        "then export DATABASE_URL=postgresql+asyncpg://gungnir:gungnir@localhost:5432/gungnir"
    )

# Normalize scheme to postgresql+asyncpg
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

if not DATABASE_URL.startswith("postgresql+asyncpg://"):
    raise RuntimeError(
        f"Gungnir requires PostgreSQL. DATABASE_URL scheme not supported: {DATABASE_URL.split(':', 1)[0]}"
    )

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,   # Verify connection is alive before using it
    pool_recycle=300,     # Recycle connections every 5min
    pool_size=5,
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
            if session.is_modified or session.new or session.deleted:
                await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
