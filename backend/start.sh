#!/bin/sh
# SkillBridge start script (Render / single container).
set -e

# The deployed product runs the consented R1 proctored exam: camera,
# microphone, entire-screen sharing and full-screen are required. Set
# ASSESSMENT_PROCTORING_MODE=r0 explicitly to serve the camera-free variant.
export ASSESSMENT_PROCTORING_MODE="${ASSESSMENT_PROCTORING_MODE:-r1}"
export EVIDENCE_RETENTION_DAYS="${EVIDENCE_RETENTION_DAYS:-30}"
echo "[start] assessment proctoring mode: ${ASSESSMENT_PROCTORING_MODE}"

ENVIRONMENT="${ENV:-${ENVIRONMENT:-development}}"

# Seed demo accounts only for an explicitly enabled, non-production deployment
# (SB-006). The seeders themselves also refuse to run in production and never
# use a hardcoded password.
if [ "${SEED_DEMO:-false}" = "true" ]; then
  if [ "$ENVIRONMENT" = "production" ] || [ "$ENVIRONMENT" = "prod" ] || [ "$ENVIRONMENT" = "live" ]; then
    echo "[start] SEED_DEMO is ignored because ENV=$ENVIRONMENT"
  else
    echo "[start] seeding demo data (non-production)..."
    python /app/seed_demo.py || echo "[start] core demo seed skipped"
    python /app/seed_enterprise.py || echo "[start] enterprise demo seed skipped"
  fi
fi

# GraphRAG question bank + graph edges. Idempotent and cheap (single connection,
# ON CONFLICT DO NOTHING), so it runs on every start to keep the bank populated.
# It contains no accounts or credentials.
echo "[start] seeding GraphRAG question bank (idempotent)..."
python /app/seed_graphrag_questions.py || echo "[start] GraphRAG seed skipped"
echo "[start] GraphRAG question seed completed."

PORT="${PORT:-8000}"
echo "[start] starting uvicorn on 0.0.0.0:${PORT}"
exec uvicorn serve:app --host 0.0.0.0 --port "${PORT}" --workers 1
