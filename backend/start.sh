#!/bin/sh
# SkillBridge start script (Render / single container / docker-compose).
set -e

# Every exam is proctored: camera, microphone, entire-screen sharing and
# full-screen are always required (see docs/PROCTORED_EXAM.md).
export EVIDENCE_RETENTION_DAYS="${EVIDENCE_RETENTION_DAYS:-30}"

ENVIRONMENT="${ENV:-${ENVIRONMENT:-development}}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

# Seed demo accounts only for an explicitly enabled, non-production deployment
# (SB-006). The seeders themselves also refuse to run in production and never
# use a hardcoded password.
if [ "${SEED_DEMO:-false}" = "true" ]; then
  if [ "$ENVIRONMENT" = "production" ] || [ "$ENVIRONMENT" = "prod" ] || [ "$ENVIRONMENT" = "live" ]; then
    echo "[start] SEED_DEMO is ignored because ENV=$ENVIRONMENT"
  else
    echo "[start] seeding demo data (non-production)..."
    python "$APP_DIR/seed_demo.py" || echo "[start] core demo seed skipped"
    python "$APP_DIR/seed_enterprise.py" || echo "[start] enterprise demo seed skipped"
  fi
fi

# GraphRAG question bank + Skill->Question graph edges. The seed is idempotent
# (stable IDs, ON CONFLICT DO NOTHING) and contains no accounts or credentials.
#   SEED_QUESTION_BANK_ON_BOOT=true  (default) seed on every start.
#   SEED_QUESTION_BANK_ON_BOOT=false seed only when the active bank is empty,
#                                    so ordinary restarts skip the work.
question_bank_empty() {
  python - <<'PY'
import sys
try:
    import main
    row = main.one("SELECT COUNT(*) AS n FROM question_bank WHERE status='active'")
    n = int((row["n"] if row is not None else 0) or 0)
except Exception as exc:  # table missing / DB not initialised yet
    print(f"[start] question bank check failed ({type(exc).__name__}); treating as empty")
    n = 0
sys.exit(0 if n == 0 else 1)
PY
}

seed_question_bank() {
  echo "[start] seeding GraphRAG question bank (idempotent)..."
  python "$APP_DIR/seed_graphrag_questions.py" || echo "[start] GraphRAG seed skipped"
  echo "[start] GraphRAG question seed completed."
}

if [ "${SEED_QUESTION_BANK_ON_BOOT:-true}" = "true" ]; then
  seed_question_bank
elif question_bank_empty; then
  echo "[start] active question bank is empty; seeding once."
  seed_question_bank
else
  echo "[start] question bank already populated; seed skipped (SEED_QUESTION_BANK_ON_BOOT=false)."
fi

PORT="${PORT:-8000}"
# Each worker is a separate process with its own DB pool and its own copy of the
# background loops (evidence purge, notifications). Keep 1 on the free plan.
WORKERS="${WEB_CONCURRENCY:-1}"
# Peers allowed to set X-Forwarded-For/-Proto for uvicorn. Default is uvicorn's
# own (localhost only). Set '*' ONLY when the container is reachable solely
# through a trusted proxy (Render's router, the compose nginx). The app's
# IP-based controls use TRUSTED_PROXY_HOPS, not this setting.
FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-127.0.0.1}"

echo "[start] starting uvicorn on 0.0.0.0:${PORT} (workers=${WORKERS})"
exec uvicorn serve:app --host 0.0.0.0 --port "${PORT}" --workers "${WORKERS}" \
  --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS}"
