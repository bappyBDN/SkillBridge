"""Render entrypoint: the FastAPI app plus the built frontend served as static files.

The API routes live in main.py. This module mounts the compiled React bundle
(WEB_DIR) at "/" so a single process serves both the SPA and /api/*. The API
routes are registered before the mount, so /api/* always wins.
"""
import os
from pathlib import Path

from fastapi.staticfiles import StaticFiles

import main

app = main.app

WEB_DIR = Path(os.getenv("WEB_DIR", "")).resolve() if os.getenv("WEB_DIR") else None
if WEB_DIR and WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
