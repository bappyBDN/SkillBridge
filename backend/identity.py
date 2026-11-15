"""CV identity plausibility check (SB-004).

The CV's own name, email and phone numbers are read from the **raw** upload,
before redaction, and compared with the signed-in account. The result is a
signal only:

* ``match``     - the CV plausibly belongs to the account holder.
* ``weak``      - some overlap; ask the candidate to confirm ownership.
* ``no_match``  - the CV looks like it belongs to someone else.
* ``unknown``   - the CV contains no usable name or contact detail.

Nothing here rejects a candidate, and nothing infers gender, ethnicity or
religion from a name. The API stores the signal, asks for an explicit "this CV
is mine" confirmation when it is weak or missing, and queues a human review.
"""
from __future__ import annotations

import re
import unicodedata

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<![\w])(?:\+?\d[\d\s\-().]{7,}\d)(?![\w])")

NAME_LABEL_RE = re.compile(
    r"(?im)^\s*(?:name|full name|নাম)\s*[:\-]\s*([A-Za-z\u0980-\u09FF][^\n]{1,60})$"
)
CV_HEADER_NOISE = re.compile(
    r"(?i)\b(curriculum vitae|resume|résumé|profile|contact|personal details)\b"
)
NON_NAME_WORDS = {
    "curriculum", "vitae", "resume", "résumé", "profile", "contact", "details",
    "address", "email", "phone", "mobile", "linkedin", "github", "portfolio",
    "summary", "objective", "experience", "education", "skills", "projects",
    "references", "declaration", "date", "birth", "nid", "passport",
}
# Common nicknames mapped to their formal name. Deliberately short: a false
# positive here only means "we asked the candidate to confirm ownership".
NICKNAMES = {
    "sadia": {"sadia", "sadiya", "sadya"},
    "rahman": {"rahman", "rehman", "rhaman"},
    "mohammad": {"mohammad", "muhammad", "md", "mohammed", "mohamed"},
    "muhammad": {"mohammad", "muhammad", "md", "mohammed", "mohamed"},
    "md": {"md", "mohammad", "muhammad", "mohammed"},
    "ahmed": {"ahmed", "ahmad", "ahamed"},
    "hossain": {"hossain", "hosain", "hussian", "hosen"},
    "chowdhury": {"chowdhury", "choudhury", "chowdhuri"},
    "khan": {"khan", "khaan"},
    "hasan": {"hasan", "hassan"},
    "abdul": {"abdul", "abdur", "abdal"},
    "nasrin": {"nasrin", "nasreen"},
    "sultana": {"sultana", "sultanna"},
}


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.casefold()


def _tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[^\w\u0980-\u09FF]+", _fold(name)) if t]


def extract_identity(raw_text: str) -> dict:
    """Pull names, emails and phones from raw CV text (before redaction)."""
    text = raw_text or ""
    emails = list(dict.fromkeys(m.group(0).lower() for m in EMAIL_RE.finditer(text)))
    phones: list[str] = []
    for match in PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if 8 <= len(digits) <= 15 and digits not in {re.sub(r"\D", "", p) for p in phones}:
            phones.append(match.group(0).strip())

    names: list[str] = []
    for match in NAME_LABEL_RE.finditer(text):
        candidate = match.group(1).strip(" -|,.")
        if candidate and not CV_HEADER_NOISE.search(candidate):
            names.append(candidate)
    # The first non-empty line of most CVs is the holder's name.
    for line in text.splitlines()[:12]:
        line = line.strip(" \t|,.")
        if not line or "@" in line or any(ch.isdigit() for ch in line):
            continue
        if CV_HEADER_NOISE.search(line):
            continue
        words = line.split()
        if not (2 <= len(words) <= 5):
            continue
        if all(_fold(w) not in NON_NAME_WORDS for w in words) and all(
            re.fullmatch(r"[A-Za-z\u0980-\u09FF'.\-]+", w) for w in words
        ):
            names.append(line)
            break
    return {
        "names": list(dict.fromkeys(names))[:3],
        "emails": emails[:5],
        "phones": phones[:5],
    }


def _same_token(a: str, b: str) -> bool:
    if a == b:
        return True
    if NICKNAMES.get(a) and b in NICKNAMES[a]:
        return True
    if NICKNAMES.get(b) and a in NICKNAMES[b]:
        return True
    # Initials: "s" matches "sadia".
    if len(a) == 1 and b.startswith(a):
        return True
    if len(b) == 1 and a.startswith(b):
        return True
    # Small edit distance for transliteration variants.
    if abs(len(a) - len(b)) <= 1 and len(a) >= 4 and _edit_distance_at_most_one(a, b):
        return True
    return False


def _edit_distance_at_most_one(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) == len(b):
        return sum(1 for x, y in zip(a, b) if x != y) <= 1
    if abs(len(a) - len(b)) != 1:
        return False
    shorter, longer = (a, b) if len(a) < len(b) else (b, a)
    i = j = 0
    skipped = False
    while i < len(shorter) and j < len(longer):
        if shorter[i] == longer[j]:
            i += 1
            j += 1
            continue
        if skipped:
            return False
        skipped = True
        j += 1
    return True


def name_similarity(account_name: str, cv_name: str) -> float:
    """0..1 similarity that tolerates order, initials, nicknames and spelling."""
    account = [t for t in _tokens(account_name) if len(t) > 0]
    cv = [t for t in _tokens(cv_name) if len(t) > 0]
    if not account or not cv:
        return 0.0
    matched = 0
    used: set[int] = set()
    for token in account:
        for index, other in enumerate(cv):
            if index in used:
                continue
            if _same_token(token, other):
                matched += 1
                used.add(index)
                break
    if not matched:
        return 0.0
    coverage_account = matched / len(account)
    coverage_cv = matched / len(cv)
    # A first-name-only CV is a weak signal, not a mismatch.
    return round(max(coverage_account, coverage_cv) * 0.6 + min(coverage_account, coverage_cv) * 0.4, 3)


def compare(account: dict, extracted: dict) -> dict:
    account_name = (account.get("name") or "").strip()
    account_email = (account.get("email") or "").strip().lower()
    best_name = ""
    best_score = 0.0
    for cv_name in extracted.get("names", []):
        score = name_similarity(account_name, cv_name)
        if score > best_score:
            best_name, best_score = cv_name, score
    emails = [e.lower() for e in extracted.get("emails", [])]
    email_match = bool(account_email and account_email in emails)

    reasons: list[str] = []
    if not extracted.get("names") and not emails:
        return {
            "status": "unknown",
            "score": None,
            "cv_name": "",
            "email_match": False,
            "reasons": ["no_name_in_cv"],
        }
    if email_match:
        reasons.append("account_email_found_in_cv")
    if best_score >= 0.8:
        status = "match"
    elif best_score > 0 or email_match:
        status = "weak"
        reasons.append("name_partial_match")
    else:
        status = "no_match"
        reasons.append("name_mismatch")
    return {
        "status": status,
        "score": best_score or None,
        "cv_name": best_name,
        "email_match": email_match,
        "reasons": reasons,
    }
