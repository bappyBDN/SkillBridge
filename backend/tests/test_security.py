"""Password policy, hashing and TOTP unit tests (SB-003)."""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import security as SEC


def test_weak_and_common_passwords_are_rejected():
    for weak in ("12345678", "password123", "Password123", "qwertyuiop12", "Abcdefghijkl"):
        assert SEC.password_errors(weak), weak
    assert SEC.password_errors("Str0ng-Passw0rd-2026") == []


def test_password_cannot_contain_email_or_name():
    errors = SEC.password_errors("Sadia-Rahman-2026!", email="sadia.rahman@example.com", name="Sadia Rahman")
    assert any("email" in e.lower() for e in errors)


def test_strength_score_reacts_to_quality():
    assert SEC.password_strength("abc") < SEC.password_strength("Str0ng-Passw0rd-2026")


def test_hash_round_trip_and_rehash_flag():
    stored = SEC.hash_password("Str0ng-Passw0rd-2026", iterations=10)
    assert stored.startswith("pbkdf2_sha256$10$")
    ok, needs_rehash = SEC.verify_password(stored, "Str0ng-Passw0rd-2026")
    assert ok and needs_rehash
    bad, _ = SEC.verify_password(stored, "wrong-password")
    assert not bad


def test_legacy_hash_still_verifies():
    import hashlib
    salt = "aabbccddeeff00112233445566778899"
    legacy = hashlib.pbkdf2_hmac("sha256", b"Str0ng-Passw0rd-2026", bytes.fromhex(salt), 200_000).hex()
    ok, needs_rehash = SEC.verify_password(legacy, "Str0ng-Passw0rd-2026", salt)
    assert ok and needs_rehash


def test_totp_matches_rfc6238_vector():
    # RFC 6238 SHA-1 test vector (8 digits truncated to 6 here).
    assert SEC.totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", at=59) == "287082"
    secret = SEC.new_totp_secret()
    code = SEC.totp_code(secret, at=time.time())
    assert SEC.verify_totp(secret, code)
    assert not SEC.verify_totp(secret, "000000")


def test_backoff_grows_with_failures():
    assert SEC.backoff_seconds(3) == 0
    assert SEC.backoff_seconds(6) > 0
    assert SEC.backoff_seconds(50) <= 900
