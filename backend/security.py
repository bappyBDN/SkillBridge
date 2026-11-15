"""Authentication hardening primitives (SB-003).

Pure helpers only: no database and no FastAPI imports, so the same rules can be
used by the API, the seed scripts and the tests.

Design notes
------------
* Passwords are stored as ``pbkdf2_sha256$<iterations>$<salt-hex>$<hash-hex>``.
  The iteration count travels with the hash, so the cost can be raised later and
  old rows are transparently rehashed on the next successful login.
* The legacy ``<salt-hex>`` + bare-hex ``pw_hash`` layout is still accepted so
  existing accounts keep working.
* TOTP (RFC 6238) is implemented with the standard library only: no extra
  dependency to install or patch.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import struct
import time

# ------------------------------------------------------------------ passwords
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 128
PBKDF2_ITERATIONS = int(os.getenv("PBKDF2_ITERATIONS", "600000"))
PBKDF2_ALGORITHM = "pbkdf2_sha256"
_SCHEME = PBKDF2_ALGORITHM

# Small, curated blocklist of the passwords that dominate credential-stuffing
# lists. Kept short on purpose: the goal is to stop the obvious ones, not to
# ship a 10 MB database.
COMMON_PASSWORDS = frozenset(
    """
    123456 1234567 12345678 123456789 1234567890 12345678910 111111 11111111
    000000 00000000 121212 123123 123321 12341234 654321 666666 7777777 88888888
    999999 147258369 1q2w3e4r 1q2w3e4r5t 1qaz2wsx 1qazxsw2 q1w2e3r4 qwerty
    qwerty123 qwertyuiop qwertyui qwerty1 password password1 password12 password123
    password1234 password12345 password123456 passw0rd p@ssw0rd p@ssword pass1234
    admin admin123 admin1234 administrator root toor letmein welcome welcome1
    welcome123 changeme iloveyou monkey dragon master sunshine princess football
    baseball superman batman trustno1 shadow michael jennifer jordan23 harley
    hunter2 computer michelle jessica pepper daniel access 696969 555555 abc123
    abcd1234 abcdef abcdefg abcdefgh a1b2c3d4 asdfghjkl asdf1234 zxcvbnm zxcvbnm123
    qazwsx qazwsxedc iloveyou1 whatever nothing secret secret123 mypassword
    test1234 test12345 testtest guest guest123 login login123 company company123
    demo demo123 demo1234 demo12345 demo123456 skillbridge talentforge
    """.split()
)

_SEQUENCES = ("abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl")


def _has_sequence(password: str, size: int = 4) -> bool:
    lowered = password.lower()
    for sequence in _SEQUENCES:
        for start in range(len(sequence) - size + 1):
            run = sequence[start:start + size]
            if run in lowered or run[::-1] in lowered:
                return True
    return False


def password_errors(password: str, *, email: str = "", name: str = "") -> list[str]:
    """Return a list of human-readable policy violations (empty means valid).

    Policy: a minimum of 8 characters, nothing else. ``email``/``name`` are kept
    in the signature so callers do not have to change.
    """
    password = password or ""
    problems: list[str] = []
    if len(password) < PASSWORD_MIN_LENGTH:
        problems.append(f"Password must be at least {PASSWORD_MIN_LENGTH} characters.")
    if len(password) > PASSWORD_MAX_LENGTH:
        problems.append(f"Password must be at most {PASSWORD_MAX_LENGTH} characters.")
    return problems


def password_strength(password: str) -> int:
    """Rough 0-4 score used for the client-side hint."""
    score = 0
    if len(password) >= PASSWORD_MIN_LENGTH:
        score += 1
    if len(password) >= 16:
        score += 1
    if re.search(r"[a-z]", password) and re.search(r"[A-Z]", password):
        score += 1
    if re.search(r"\d", password) and re.search(r"[^A-Za-z0-9]", password):
        score += 1
    if password.lower() in COMMON_PASSWORDS or _has_sequence(password):
        score = max(0, score - 2)
    return min(score, 4)


# ------------------------------------------------------------------ hashing
def _encode(iterations: int, salt: bytes, digest: bytes) -> str:
    return f"{_SCHEME}${iterations}${salt.hex()}${digest.hex()}"


def hash_password(password: str, *, iterations: int | None = None) -> str:
    iterations = iterations or PBKDF2_ITERATIONS
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return _encode(iterations, salt, digest)


def verify_password(stored: str, password: str, legacy_salt: str | None = None) -> tuple[bool, bool]:
    """Return ``(matches, needs_rehash)`` for a stored hash."""
    stored = stored or ""
    if stored.startswith(_SCHEME + "$"):
        try:
            _, iterations, salt_hex, digest_hex = stored.split("$")
            iterations = int(iterations)
            digest = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), iterations
            )
        except (ValueError, TypeError):
            return False, False
        return hmac.compare_digest(digest.hex(), digest_hex), iterations < PBKDF2_ITERATIONS
    # Legacy: pbkdf2_hmac(sha256, 200_000) hex digest with a separate salt column.
    if not legacy_salt:
        return False, False
    try:
        legacy = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(legacy_salt), 200_000
        ).hex()
    except (ValueError, TypeError):
        return False, False
    return hmac.compare_digest(legacy, stored), True


# ------------------------------------------------------------------ TOTP MFA
def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret: str, *, at: float | None = None, step: int = 30, digits: int = 6) -> str:
    padding = "=" * (-len(secret) % 8)
    key = base64.b32decode(secret + padding, casefold=True)
    counter = int((at if at is not None else time.time()) // step)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def verify_totp(secret: str, code: str, *, at: float | None = None, window: int = 1) -> bool:
    if not secret or not code:
        return False
    code = re.sub(r"\s+", "", str(code))
    if not code.isdigit():
        return False
    base = at if at is not None else time.time()
    for offset in range(-window, window + 1):
        if hmac.compare_digest(totp_code(secret, at=base + offset * 30), code):
            return True
    return False


def otpauth_url(secret: str, email: str, issuer: str = "TalentForge") -> str:
    label = f"{issuer}:{email}"
    return (
        f"otpauth://totp/{label}?secret={secret}&issuer={issuer}"
        f"&algorithm=SHA1&digits=6&period=30"
    )


# ------------------------------------------------------------------ throttling
def backoff_seconds(failures: int, *, base: int = 5, cap: int = 900) -> int:
    """Exponential backoff for repeated failures (0 means 'allowed')."""
    if failures <= 4:
        return 0
    return min(cap, base * (2 ** (failures - 5)))
