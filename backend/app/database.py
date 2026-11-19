from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from . import config

if config.DATABASE_URL.startswith("sqlite"):
    _engine_args = {"connect_args": {"check_same_thread": False}}
else:
    # Neon: pooled (PgBouncer) endpoint, computes suspend when idle so drop stale connections
    _engine_args = {"pool_pre_ping": True, "pool_recycle": 300, "pool_size": 5, "max_overflow": 5,
                    "connect_args": {"prepare_threshold": None}}  # no server-side prepared statements behind PgBouncer

engine = create_engine(config.DATABASE_URL, **_engine_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
