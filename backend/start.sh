#!/bin/sh
# SkillBridge start script (Render / single container).
set -e

# Seed demo/test data once. Idempotent: no-op when the demo user already exists.
if [ "${SEED_DEMO:-false}" = "true" ]; then
  echo "[start] seeding demo data..."
  python /app/seed_demo.py || echo "[start] seed skipped"
fi

PORT="${PORT:-8000}"
echo "[start] starting uvicorn on 0.0.0.0:${PORT}"
exec uvicorn serve:app --host 0.0.0.0 --port "${PORT}" --workers 1
