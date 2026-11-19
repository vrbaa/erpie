"""All environment configuration, read in one place."""
import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent

# existing environment variables win; backend/.env beats the repo-root .env.local (written by `neon env pull`)
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(BACKEND_DIR.parent / ".env.local")


def _database_url() -> str:
    """DATABASE_URL as a SQLAlchemy URL: Postgres URLs use psycopg 3, unset falls back to local SQLite."""
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return f"sqlite:///{BACKEND_DIR / 'erpie.db'}"
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


DATABASE_URL = _database_url()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip() or None
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").strip().lower() or None
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or None
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "yes")
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
