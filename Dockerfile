# SkillBridge Global R0 - single-container image for Render (and any single-host deploy).
# Builds the React frontend, installs the FastAPI backend, and serves both from one
# uvicorn process (serve.py mounts the built frontend at "/").
#
#   docker build -t skillbridge .
#   docker run -e PORT=8080 -e SECRET_KEY=... -p 8080:8080 skillbridge

# ---- 1. Build the frontend -------------------------------------------------
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
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

RUN mkdir -p /data
EXPOSE 8000

CMD ["sh", "/app/start.sh"]
