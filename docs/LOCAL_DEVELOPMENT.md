# Local development

## Run with your real data (Neon PostgreSQL, as configured in `.env`)

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
