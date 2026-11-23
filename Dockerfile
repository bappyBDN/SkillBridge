# SkillBridge Global R0 - single-container image for Render (and any single-host deploy).
# Builds the React frontend, installs the FastAPI backend, and serves both from one
# uvicorn process (serve.py mounts the built frontend at "/").
#
#   docker build -t skillbridge .
#   docker run -e PORT=8080 -e SECRET_KEY="$(openssl rand -hex 32)" -p 8080:8080 skillbridge

# ---- 1. Build the frontend -------------------------------------------------
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# ---- 2. Runtime ------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WEB_DIR=/app/web \
    DB_PATH=/data/skillbridge.db

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .

# Built frontend becomes the static site served by FastAPI.
COPY --from=web /web/dist /app/web

# Run as an unprivileged user (same approach as backend/Dockerfile). /data holds
# the SQLite fallback and local file storage when those are used.
RUN useradd -m app && mkdir -p /data && chown app /data
USER app
EXPOSE 8000
# Liveness only (cheap, no DB round trip). Readiness is GET /api/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:%s/api/health' % os.getenv('PORT','8000'), timeout=4)"

# No secrets are baked into the image: SECRET_KEY, DATABASE_URL and provider keys
# are supplied at runtime (docker run -e ... or platform environment variables).
CMD ["sh", "/app/start.sh"]
