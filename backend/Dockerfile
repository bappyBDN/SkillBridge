FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-ben \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# backend/.dockerignore keeps data/, .env, *.db and .secret out of the image.
# No secrets are baked in: SECRET_KEY, DATABASE_URL and provider keys come from
# the runtime environment.
COPY . .
RUN useradd -m app && mkdir -p /data && chown app /data
USER app
EXPOSE 8000
# Liveness only (cheap, no DB round trip). Readiness is GET /api/ready.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:%s/api/health' % os.getenv('PORT','8000'), timeout=2)"
# start.sh optionally seeds the GraphRAG question bank (idempotent), then launches uvicorn.
CMD ["sh", "start.sh"]
