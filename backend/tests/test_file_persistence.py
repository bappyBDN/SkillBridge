"""CVs and profile photos must survive a wiped container disk, and CV text
extraction must keep what candidates actually wrote (headers, tabs, breaks)."""
import io
import os
import shutil
import sys
import tempfile
import uuid
import zipfile

_TMP = tempfile.mkdtemp(prefix="sb_persist_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import cv_store
import main
import storage

client = TestClient(main.app)


def _candidate():
    email = uuid.uuid4().hex + "@example.com"
    r = client.post("/api/auth/register", json={"email": email, "name": "Rahim Uddin", "password": "Str0ng-Passw0rd-2026"})
    assert r.status_code == 200, r.text
    headers = {"Authorization": "Bearer " + r.json()["token"]}
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    return uid, headers


def _png():
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (20, 120, 200)).save(out, format="PNG")
    return out.getvalue()


# ------------------------------------------------------------------ database backend
def test_database_storage_roundtrip_overwrite_and_missing_key():
    s = storage.DatabaseStorage()
    key = f"cv/1/{uuid.uuid4().hex}.pdf"
    s.put(key, b"%PDF-1 first", "application/pdf")
    s.put(key, b"%PDF-1 second", "application/pdf")
    assert s.get(key) == b"%PDF-1 second" and s.exists(key)
    s.delete(key)
    s.delete(key)  # idempotent
    assert not s.exists(key)
    with pytest.raises(storage.StorageNotFound):
        s.get(key)
    with pytest.raises(storage.StorageError):
        s.put("../escape", b"x")


def test_database_storage_migrates_files_from_the_old_local_folder():
    legacy_dir = os.path.join(_TMP, "legacy_" + uuid.uuid4().hex)
    legacy = storage.LocalStorage(legacy_dir)
    key = f"avatars/7/{uuid.uuid4().hex}.webp"
    legacy.put(key, b"old-photo")
    s = storage.DatabaseStorage(legacy)
    assert s.exists(key)
    assert s.get(key) == b"old-photo"
    shutil.rmtree(legacy_dir)  # the container disk is wiped on the next deploy ...
    assert storage.DatabaseStorage().get(key) == b"old-photo"  # ... the copy in the DB remains


def test_default_backend_is_the_database():
    old = os.environ.pop("STORAGE_BACKEND", None)
    storage.reset_storage_for_tests()
    try:
        assert storage.get_storage().name == "database"
    finally:
        if old is not None:
            os.environ["STORAGE_BACKEND"] = old
        storage.reset_storage_for_tests()


def test_cv_and_photo_survive_losing_the_local_disk(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "database")
    monkeypatch.setenv("STORAGE_LOCAL_DIR", os.path.join(_TMP, "disk_" + uuid.uuid4().hex))
    storage.reset_storage_for_tests()
    try:
        uid, headers = _candidate()
        cv = b"Rahim Uddin\nData Engineer\nSkills: Python, SQL, Docker\nBuilt ETL pipelines for three years."
        document = cv_store.save_document(uid, "cv.txt", cv)
        assert client.post("/api/candidate/avatar", files={"file": ("me.png", _png(), "image/png")},
                           headers=headers).status_code == 200
        # Simulate a redeploy on an ephemeral filesystem: a fresh process, no local files.
        shutil.rmtree(os.environ["STORAGE_LOCAL_DIR"], ignore_errors=True)
        storage.reset_storage_for_tests()
        assert cv_store.read_document_bytes(uid, document["id"]) == cv
        photo = client.get("/api/candidate/avatar", headers=headers)
        assert photo.status_code == 200 and photo.content[:4] == b"RIFF"
        assert main.avatar_metadata(uid)["has_avatar"] is True
    finally:
        storage.reset_storage_for_tests()


def test_a_photo_lost_before_the_fix_is_cleared_instead_of_failing_forever():
    uid, headers = _candidate()
    main.run("INSERT INTO candidate_avatars(user_id,storage_key,content_type,updated) VALUES (?,?,?,?)",
             (uid, f"avatars/{uid}/{uuid.uuid4().hex}.webp", "image/webp", 1.0))
    assert main.avatar_metadata(uid)["has_avatar"] is True
    missing = client.get("/api/candidate/avatar", headers=headers)
    assert missing.status_code == 404
    assert main.avatar_metadata(uid)["has_avatar"] is False
    assert client.get("/api/me/export", headers=headers).status_code == 200


# ------------------------------------------------------------------ DOCX text extraction
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'


def _p(*parts, props=""):
    return "<w:p>" + props + "".join(parts) + "</w:p>"


def _r(text):
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


TAB, BR = "<w:r><w:tab/></w:r>", "<w:r><w:br/></w:r>"


def _docx(body, header="", footer=""):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", f'<?xml version="1.0"?><w:document {W} {MC}><w:body>{body}</w:body></w:document>')
        if header:
            z.writestr("word/header1.xml", f'<?xml version="1.0"?><w:hdr {W}>{header}</w:hdr>')
            z.writestr("word/header2.xml", f'<?xml version="1.0"?><w:hdr {W}>{header}</w:hdr>')
        if footer:
            z.writestr("word/footer1.xml", f'<?xml version="1.0"?><w:ftr {W}>{footer}</w:ftr>')
    return out.getvalue()


def test_docx_reads_header_contact_details_tabs_breaks_and_tables():
    tab_stops = '<w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>'
    body = (
        _p(_r("Experience"))
        + _p(_r("Senior Data Engineer"), TAB, _r("2021 - Present"), props=tab_stops)
        + _p(_r("Built ETL in Python"), BR, _r("Led SQL &amp; dbt migration"))
        + "<w:tbl><w:tr><w:tc>" + _p(_r("Skills")) + "</w:tc><w:tc>" + _p(_r("Python, SQL, Docker")) + "</w:tc></w:tr></w:tbl>"
        + _p("<w:r><mc:AlternateContent><mc:Choice>" + _p(_r("Portfolio box")) + "</mc:Choice>"
             "<mc:Fallback>" + _p(_r("Portfolio box")) + "</mc:Fallback></mc:AlternateContent></w:r>")
    )
    header = _p(_r("Rahim Uddin")) + _p(_r("rahim@example.com"), TAB, _r("+8801712345678"))
    text, info = main.read_profile_cv("cv.docx", _docx(body, header, _p(_r("github.com/rahim"))))
    lines = text.splitlines()
    assert info["parser"] == "docx_xml"
    assert lines[:2] == ["Rahim Uddin", "rahim@example.com +8801712345678"]  # header first, once
    assert "Senior Data Engineer 2021 - Present" in lines
    assert "Built ETL in Python" in lines and "Led SQL & dbt migration" in lines
    assert "Python, SQL, Docker" in lines
    assert lines.count("Portfolio box") == 1
    assert "https://github.com/rahim" in info["links_found"]


def test_legacy_cv_upload_uses_the_same_reader():
    header = _p(_r("Rahim Uddin")) + _p(_r("rahim@example.com"))
    body = _p(_r("Skills")) + _p(_r("Python"), TAB, _r("SQL"), TAB, _r("Docker")) + _p(_r("Built data pipelines and dashboards."))
    text = main.read_upload("cv.docx", _docx(body, header))
    assert "rahim@example.com" in text and "Python SQL Docker" in text
    assert "&amp;" not in text
