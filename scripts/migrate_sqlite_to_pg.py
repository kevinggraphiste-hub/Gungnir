"""
Gungnir — One-shot migrator : SQLite legacy → PostgreSQL.

Usage (depuis la racine projet, ou dans le container) :

    # 1. Postgres doit tourner et DATABASE_URL doit etre exportee :
    export DATABASE_URL=postgresql+asyncpg://gungnir:gungnir@localhost:5432/gungnir

    # 2. Lancer la migration :
    python scripts/migrate_sqlite_to_pg.py --sqlite data/gungnir.db

Le script :
- lit la base SQLite en async (aiosqlite)
- cree le schema Postgres via `Base.metadata.create_all`
- copie toutes les tables dans l'ordre des foreign keys
- idempotent : `ON CONFLICT (id) DO NOTHING` sur chaque ligne
- resynchronise les sequences Postgres apres insertion

Peut donc etre relance sans risque si interrompu.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from backend.core.db.models import Base

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("migrate_sqlite_to_pg")

BATCH_SIZE = 500


def _normalize_pg_url(url: str) -> str:
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if not url.startswith("postgresql+asyncpg://"):
        raise SystemExit(f"DATABASE_URL n'est pas une URL Postgres asyncpg valide : {url}")
    return url


async def _copy_table(src_engine: AsyncEngine, dst_engine: AsyncEngine, table) -> tuple[int, int]:
    """Copie une table avec ON CONFLICT DO NOTHING. Retourne (lus, inseres).

    Tolere les schemas SQLite plus anciens : ne SELECT que les colonnes
    presentes dans la source. Les colonnes manquantes cote PG prennent
    leur valeur par defaut definie dans le modele.
    """
    pk_cols = [c.name for c in table.primary_key.columns]
    if not pk_cols:
        log.warning(f"  → {table.name} : pas de PK, utilisation d'INSERT simple")

    read = 0
    inserted = 0

    async with src_engine.connect() as src_conn:
        # SQLite peut ne pas avoir toutes les tables (schema legacy)
        check = await src_conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table.name},
        )
        if check.first() is None:
            log.info(f"  → {table.name} : absente de la source, skip")
            return (0, 0)

        # Intersection colonnes SQLite ∩ colonnes du modele — tolere
        # le drift de schema (colonnes ajoutees apres coup)
        r = await src_conn.execute(text(f'PRAGMA table_info("{table.name}")'))
        sqlite_col_names = {row.name for row in r}
        common = [c for c in table.columns if c.name in sqlite_col_names]
        if not common:
            log.info(f"  → {table.name} : aucune colonne commune, skip")
            return (0, 0)

        missing = sqlite_col_names ^ {c.name for c in table.columns}
        if missing:
            only_src = sqlite_col_names - {c.name for c in table.columns}
            only_dst = {c.name for c in table.columns} - sqlite_col_names
            if only_src:
                log.info(f"    (colonnes source ignorees : {sorted(only_src)})")
            if only_dst:
                log.info(f"    (colonnes dest en defaut : {sorted(only_dst)})")

        result = await src_conn.stream(select(*common))
        async for partition in result.partitions(BATCH_SIZE):
            rows = [dict(row._mapping) for row in partition]
            read += len(rows)
            if not rows:
                continue

            async with dst_engine.begin() as dst_conn:
                stmt = pg_insert(table).values(rows)
                if pk_cols:
                    stmt = stmt.on_conflict_do_nothing(index_elements=pk_cols)
                res = await dst_conn.execute(stmt)
                inserted += res.rowcount or 0

    return (read, inserted)


async def _resync_sequences(dst_engine: AsyncEngine) -> None:
    """Apres insertion avec PK explicites, les sequences Postgres sont en retard.
    On les aligne sur MAX(id) pour que les prochains INSERT sans PK marchent."""
    async with dst_engine.begin() as conn:
        # Recuperer toutes les sequences liees a une colonne
        seqs = await conn.execute(text("""
            SELECT
                s.relname AS seq_name,
                t.relname AS table_name,
                a.attname AS column_name
            FROM pg_class s
            JOIN pg_depend d ON d.objid = s.oid
            JOIN pg_class t ON d.refobjid = t.oid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
            WHERE s.relkind = 'S' AND t.relkind = 'r'
        """))
        for row in seqs:
            seq, tbl, col = row.seq_name, row.table_name, row.column_name
            # setval(seq, COALESCE(MAX(col), 1), MAX IS NOT NULL)
            await conn.execute(text(f"""
                SELECT setval(
                    '{seq}',
                    COALESCE((SELECT MAX("{col}") FROM "{tbl}"), 1),
                    (SELECT MAX("{col}") IS NOT NULL FROM "{tbl}")
                )
            """))
            log.info(f"  → seq {seq} resynchronisee")


async def main(sqlite_path: str, pg_url: str) -> None:
    sqlite_file = Path(sqlite_path)
    if not sqlite_file.exists():
        raise SystemExit(f"Fichier SQLite introuvable : {sqlite_file}")

    src_url = f"sqlite+aiosqlite:///{sqlite_file.resolve()}"
    dst_url = _normalize_pg_url(pg_url)

    log.info(f"Source : {src_url}")
    log.info(f"Dest   : {dst_url.split('@')[-1] if '@' in dst_url else dst_url}")

    src_engine = create_async_engine(src_url)
    dst_engine = create_async_engine(dst_url)

    try:
        # 1. Schema cible (idempotent : ne recree pas les tables existantes)
        log.info("Creation du schema Postgres si necessaire…")
        async with dst_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        # 2. Copie table par table, dans l'ordre des FK
        total_read = 0
        total_inserted = 0
        for table in Base.metadata.sorted_tables:
            log.info(f"Migration : {table.name}")
            read, inserted = await _copy_table(src_engine, dst_engine, table)
            log.info(f"  → {read} lus, {inserted} inseres (skip={read - inserted})")
            total_read += read
            total_inserted += inserted

        # 3. Resync des sequences
        log.info("Resynchronisation des sequences Postgres…")
        await _resync_sequences(dst_engine)

        log.info("=" * 50)
        log.info(f"Migration terminee : {total_inserted}/{total_read} lignes inserees")
        log.info("=" * 50)

    finally:
        await src_engine.dispose()
        await dst_engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SQLite legacy → Postgres migrator")
    parser.add_argument("--sqlite", required=True, help="Chemin vers le .db SQLite source")
    parser.add_argument(
        "--database-url",
        default=os.getenv("DATABASE_URL", ""),
        help="URL Postgres de destination (defaut: $DATABASE_URL)",
    )
    args = parser.parse_args()

    if not args.database_url:
        raise SystemExit("DATABASE_URL non definie (--database-url ou env var).")

    asyncio.run(main(args.sqlite, args.database_url))
