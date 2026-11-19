"""All environment configuration, read in one place."""
import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BACKEND_DIR / ".env")  # existing environment variables win

DATABASE_URL = os.getenv("DATABASE_URL", "").strip() or f"sqlite:///{BACKEND_DIR / 'erpie.db'}"
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip() or None
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").strip().lower() or None
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or None
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "yes")
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
