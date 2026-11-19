"""One-off: copy every table from the local SQLite file to the DATABASE_URL target (Postgres).

Usage (from backend/):  python -m scripts.copy_sqlite_to_db [path/to/erpie.db]
Refuses to run if the target already has employees. Use the direct (unpooled) URL if you can:
  DATABASE_URL=$DATABASE_URL_UNPOOLED python -m scripts.copy_sqlite_to_db
"""
import sys
from pathlib import Path

from sqlalchemy import create_engine, func, insert, select, text

from app import config, models  # noqa: F401  (models registers the tables on Base.metadata)
from app.database import Base, engine


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else config.BACKEND_DIR / "erpie.db"
    if engine.dialect.name != "postgresql":
        sys.exit(f"DATABASE_URL must point to Postgres (got {engine.dialect.name}).")
    if not src_path.is_file():
        sys.exit(f"SQLite file not found: {src_path}")

    src = create_engine(f"sqlite:///file:{src_path.as_posix()}?mode=ro&uri=true")
    Base.metadata.create_all(engine)
    with engine.connect() as dst:
        if dst.scalar(select(func.count()).select_from(models.Employee.__table__)):
            sys.exit("Target already has employees - refusing to copy.")

    with src.connect() as s, engine.begin() as d:
        for table in Base.metadata.sorted_tables:
            rows = [dict(r) for r in s.execute(select(table)).mappings()]
            if rows:
                d.execute(insert(table), rows)
            print(f"{table.name}: {len(rows)}")
            pk = list(table.primary_key.columns)
            if len(pk) == 1 and pk[0].autoincrement is not False and pk[0].type.python_type is int:
                d.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{table.name}', '{pk[0].name}'), "
                    f"COALESCE((SELECT MAX({pk[0].name}) FROM {table.name}), 0) + 1, false)"))
    print("done")


if __name__ == "__main__":
    main()
