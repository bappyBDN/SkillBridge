"""Demo seeders must work when opted in and refuse in production (SB-006 / SB-009)."""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="sb_seed_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import main
import seed_demo


def test_seed_refuses_when_not_opted_in(monkeypatch):
    monkeypatch.setenv("SEED_DEMO", "false")
    with pytest.raises(SystemExit):
        seed_demo._guard()


def test_seed_refuses_in_production(monkeypatch):
    monkeypatch.setenv("SEED_DEMO", "true")
    monkeypatch.setattr(seed_demo, "IS_PRODUCTION", True)
    with pytest.raises(SystemExit):
        seed_demo._guard()


def test_seed_creates_a_working_demo_candidate_without_a_hardcoded_password(monkeypatch):
    monkeypatch.setenv("SEED_DEMO", "true")
    monkeypatch.delenv("SEED_DEMO_PASSWORD", raising=False)
    main.run("DELETE FROM passports WHERE user_id IN (SELECT id FROM users WHERE email=?)", (seed_demo.DEMO_EMAIL,))
    for table, column, _label in main._registry_tables():
        main.run(f"DELETE FROM {table} WHERE {column}=(SELECT id FROM users WHERE email=?)", (seed_demo.DEMO_EMAIL,))
    main.run("DELETE FROM users WHERE email=?", (seed_demo.DEMO_EMAIL,))

    seed_demo.seed()

    user = main.one("SELECT * FROM users WHERE email=?", (seed_demo.DEMO_EMAIL,))
    assert user and user["email_verified"]
    assert not user["pw_hash"].startswith("demo12345")
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (user["id"],))["n"] == 2
    assert main.one("SELECT COUNT(*) AS n FROM passports WHERE user_id=?", (user["id"],))["n"] == 1
    consent = main.one("SELECT version FROM consents WHERE user_id=?", (user["id"],))
    assert consent["version"] == main.CONSENT_VERSION


def test_enterprise_seed_has_no_static_credentials():
    source = open(os.path.join(os.path.dirname(__file__), "..", "seed_enterprise.py"), encoding="utf-8").read()
    assert "demo12345" not in source
    assert "12345678" not in source
    assert "admin@test.com" not in source
