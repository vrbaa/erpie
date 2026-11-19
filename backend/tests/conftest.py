import os

# Tests use in-memory SQLite and plain http: neutralize backend/.env and .env.local (set before app.config loads).
os.environ["DATABASE_URL"] = ""
os.environ["COOKIE_SECURE"] = "false"  # the TestClient talks plain http
