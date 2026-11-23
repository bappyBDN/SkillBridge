# Local development

## Run with your real data (Neon PostgreSQL, as configured in `.env`)

> Caution: this connects to whatever `DATABASE_URL` the repository `.env`
> holds. If that is the production database, every action you take locally
> changes live data. Prefer the SQLite mode below or a Neon branch for
> development.

```bash
cd backend
python run_local.py
```

`run_local.py` loads the repository `.env` (`DATABASE_URL`, `SECRET_KEY`, ...)
before importing the app, which is what makes your existing users, question
bank, attempts and passports visible. Then start the UI:

```bash
cd frontend
npm run dev      # http://localhost:5173
```

## Run with a throwaway local SQLite database

```bash
cd backend
python run_local.py --sqlite      # backend/data/skillbridge.db
```

Demo accounts (only in SQLite mode): `demo@skillbridge.test`,
`recruiter@skillbridge.test`, `admin@skillbridge.test` with the password set by
`SEED_DEMO_PASSWORD`.

> Note: `uvicorn --env-file` does not reliably pass variables to the reloader
> worker on Windows, so use `run_local.py` instead. Without it uvicorn falls back
> to SQLite and your PostgreSQL data appears to be missing.

## Quality gates (same as CI)

Tests never need a real database: they use throwaway SQLite. Unset
`DATABASE_URL` in your shell before running them.

```bash
# Backend: full suite + coverage gate (pip install pytest pytest-cov first)
cd backend && python -m pytest -q tests --cov=. --cov-fail-under=72

# Frontend
cd frontend
npm ci
npm run lint
npm test                      # node unit tests
npm run build
npx playwright install chromium
npx playwright test           # starts its own Vite server; API is mocked
PW_PORT=5180 npx playwright test   # if port 5174 is taken
```

## Docker

```bash
docker compose up --build                              # Neon via DATABASE_URL in .env
docker compose --profile localdb up --build            # local Postgres container
docker compose -f docker-compose.sqlite.yml up --build # SQLite + local files
```

The UI is on http://localhost:8080 (nginx proxies `/api`). Both services have
healthchecks; `docker compose ps` shows `healthy` once `/api/health` answers.
Operations, headers/CSP and backups: `docs/OPERATIONS.md`.
