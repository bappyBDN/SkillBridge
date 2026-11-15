"""Run the backend locally with the repository .env (Neon/PostgreSQL when configured).

    python run_local.py                 # uses ../.env (DATABASE_URL, SECRET_KEY, ...)
    python run_local.py --sqlite        # forces a throwaway local SQLite database

Uvicorn's own ``--env-file`` flag is not reliable with ``--reload`` on Windows,
so this launcher loads the file itself before importing the app.
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent
ENV_FILE = BACKEND.parent / ".env"

if "--sqlite" in sys.argv:
    os.environ.pop("DATABASE_URL", None)
    os.environ.setdefault("DB_PATH", str(BACKEND / "data" / "skillbridge.db"))
else:
    if ENV_FILE.exists():
        load_dotenv(ENV_FILE, override=True)
        print(f"[local] loaded {ENV_FILE}")
    if not os.getenv("DATABASE_URL"):
        os.environ.setdefault("DB_PATH", str(BACKEND / "data" / "skillbridge.db"))
        print("[local] DATABASE_URL not set - using local SQLite")

os.environ.setdefault("SEED_DEMO", "false")

import uvicorn

if __name__ == "__main__":
    print("[local] database:", "postgres" if os.getenv("DATABASE_URL") else os.getenv("DB_PATH"))
    uvicorn.run(
        "serve:app",
        host="127.0.0.1",
        port=int(os.getenv("PORT", "8000")),
        reload=True,
        reload_dirs=[str(BACKEND)],
    )
