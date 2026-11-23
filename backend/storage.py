"""File storage for original CV documents and candidate profile photos.

One small interface, three backends:

* ``database`` - bytes kept in the application database (default). Survives
                 container restarts and redeploys on hosts with an ephemeral
                 filesystem (Render, Railway, Fly without a volume ...), because
                 the database itself (SQLite file or PostgreSQL/Neon) is durable.
* ``local``    - files on disk. Only permanent when the folder is on a mounted
                 volume (see docker-compose.yml).
* ``s3``       - any S3-compatible bucket (AWS S3, Cloudflare R2, Supabase Storage,
                 MinIO, DigitalOcean Spaces ...) for when TalentForge is scaled

Switch backend with the STORAGE_BACKEND env var - no code changes needed.
The rest of the app only calls ``get_storage()`` and never knows which backend is active.

Env vars
--------
STORAGE_BACKEND        database (default) | local | s3
STORAGE_LOCAL_DIR      local folder. Default: <folder of DB_PATH>/cv_files. With the
                       database backend, files still found here (written before the
                       switch) are read once and copied into the database.
S3_BUCKET              s3 only (required)
S3_REGION              s3 only. Default: auto
S3_ENDPOINT_URL        s3 only. Leave empty for AWS; set for R2 / MinIO / Supabase
S3_ACCESS_KEY_ID       s3 only. Optional if the host provides an IAM role
S3_SECRET_ACCESS_KEY   s3 only
S3_PREFIX              s3 only. Optional key prefix, e.g. "prod/"
"""
from __future__ import annotations

import os
import tempfile
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


class StorageError(RuntimeError):
    pass


class StorageNotFound(StorageError):
    """The key does not exist. Unlike other StorageErrors this is not transient."""


class StorageBackend(ABC):
    name = "abstract"

    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None: ...

    @abstractmethod
    def get(self, key: str) -> bytes: ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """Delete a file. Must NOT raise if the file is already gone."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    def delete_prefix(self, prefix: str) -> int:
        """Delete every file whose key starts with ``prefix`` (e.g. ``cv/42/``).

        Returns how many files were removed. Must NOT raise when nothing matches.
        """
        raise NotImplementedError

    def presigned_url(self, key: str, expires: int = 300) -> Optional[str]:
        """Temporary direct-download URL, or None if the backend cannot provide one."""
        return None


def _clean_prefix(prefix: str) -> str:
    """A prefix must name at least one folder (``cv/42/``) so it can never match everything."""
    prefix = (prefix or "").replace("\\", "/").lstrip("/")
    if "/" not in prefix or not prefix.split("/")[0]:
        raise StorageError("Invalid storage prefix")
    _clean_key(prefix.rstrip("/") or "x")
    return prefix


def _clean_key(key: str) -> str:
    """Reject anything that could escape the storage root."""
    key = key.replace("\\", "/").lstrip("/")
    parts = key.split("/")
    if not key or any(p in ("", ".", "..") for p in parts):
        raise StorageError("Invalid storage key")
    return key


class LocalStorage(StorageBackend):
    name = "local"

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / _clean_key(key)).resolve()
        if self.root not in p.parents:
            raise StorageError("Invalid storage key")
        return p

    def put(self, key, data, content_type="application/octet-stream"):
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file then rename, so a crash never leaves a half-written CV.
        fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, p)
        except Exception:
            try: os.unlink(tmp)
            except OSError: pass
            raise

    def get(self, key):
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError as e:
            raise StorageNotFound("File not found") from e

    def delete(self, key):
        try:
            self._path(key).unlink()
        except FileNotFoundError:
            pass

    def exists(self, key):
        return self._path(key).is_file()

    def delete_prefix(self, prefix):
        prefix = _clean_prefix(prefix)
        removed = 0
        folder, _, stem = prefix.rpartition("/")
        base = self._path(folder + "/.probe").parent if folder else self.root
        if not base.is_dir():
            return 0
        for path in list(base.rglob("*")):
            rel = path.relative_to(self.root).as_posix()
            if path.is_file() and rel.startswith(prefix):
                try:
                    path.unlink()
                    removed += 1
                except FileNotFoundError:
                    pass
                except OSError as e:
                    raise StorageError(f"Local delete failed: {type(e).__name__}") from e
        return removed


class S3Storage(StorageBackend):
    name = "s3"

    def __init__(self, bucket: str, region: str = "auto", endpoint_url: str = "",
                 access_key: str = "", secret_key: str = "", prefix: str = ""):
        if not bucket:
            raise StorageError("S3_BUCKET is required when STORAGE_BACKEND=s3")
        try:
            import boto3  # imported lazily so local development does not need boto3
            from botocore.config import Config
        except ImportError as e:
            raise StorageError("boto3 is not installed. Run: pip install -r requirements-cloud.txt") from e
        kwargs = {"region_name": region or "auto", "config": Config(signature_version="s3v4")}
        if endpoint_url: kwargs["endpoint_url"] = endpoint_url
        if access_key and secret_key:
            kwargs["aws_access_key_id"] = access_key
            kwargs["aws_secret_access_key"] = secret_key
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.client = boto3.client("s3", **kwargs)

    def _k(self, key: str) -> str:
        return self.prefix + _clean_key(key)

    def put(self, key, data, content_type="application/octet-stream"):
        # CVs are personal data: always encrypt at rest and keep the object private.
        extra = {"ContentType": content_type}
        if os.getenv("S3_SSE", "AES256").lower() != "none":
            extra["ServerSideEncryption"] = "AES256"
        try:
            self.client.put_object(Bucket=self.bucket, Key=self._k(key), Body=data, **extra)
        except Exception as e:
            raise StorageError(f"S3 upload failed: {type(e).__name__}") from e

    def get(self, key):
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self._k(key))["Body"].read()
        except Exception as e:
            code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
            if code in ("NoSuchKey", "404", "NotFound"):
                raise StorageNotFound("File not found") from e
            raise StorageError(f"S3 download failed: {type(e).__name__}") from e

    def delete(self, key):
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self._k(key))  # S3 delete is idempotent
        except Exception as e:
            raise StorageError(f"S3 delete failed: {type(e).__name__}") from e

    def exists(self, key):
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._k(key))
            return True
        except Exception:
            return False

    def delete_prefix(self, prefix):
        full = self.prefix + _clean_prefix(prefix)
        removed = 0
        try:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=full):
                keys = [{"Key": item["Key"]} for item in page.get("Contents", []) or []]
                if keys:
                    self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True})
                    removed += len(keys)
        except Exception as e:
            raise StorageError(f"S3 prefix delete failed: {type(e).__name__}") from e
        return removed

    def presigned_url(self, key, expires=300):
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": self._k(key)}, ExpiresIn=expires)


DB_SCHEMA = """CREATE TABLE IF NOT EXISTS stored_files(
    storage_key TEXT PRIMARY KEY, content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, data BYTEA NOT NULL, updated REAL NOT NULL)"""


class DatabaseStorage(StorageBackend):
    """Keep file bytes in the application database (SQLite or PostgreSQL).

    ``legacy`` is an optional LocalStorage holding files written before the
    switch to this backend; a file found there is copied into the database on
    first read, so existing uploads are migrated instead of lost.
    """
    name = "database"

    def __init__(self, legacy: Optional[LocalStorage] = None):
        self.legacy = legacy
        self._ready = False

    @staticmethod
    def _db():
        import main  # lazy: main imports this module
        return main

    def _ensure(self):
        if not self._ready:
            self._db().run(DB_SCHEMA)
            self._ready = True

    def put(self, key, data, content_type="application/octet-stream"):
        key = _clean_key(key)
        self._ensure()
        m = self._db()
        try:
            m.run(
                "INSERT INTO stored_files(storage_key,content_type,size_bytes,data,updated) VALUES (?,?,?,?,?) "
                "ON CONFLICT(storage_key) DO UPDATE SET content_type=excluded.content_type,"
                "size_bytes=excluded.size_bytes,data=excluded.data,updated=excluded.updated",
                (key, content_type, len(data), bytes(data), time.time()),
            )
        except Exception as e:
            raise StorageError(f"Database upload failed: {type(e).__name__}") from e

    def get(self, key):
        key = _clean_key(key)
        self._ensure()
        try:
            row = self._db().one("SELECT data,content_type FROM stored_files WHERE storage_key=?", (key,))
        except Exception as e:
            raise StorageError(f"Database download failed: {type(e).__name__}") from e
        if row:
            return bytes(row["data"])
        if self.legacy is not None:
            data = self.legacy.get(key)  # raises StorageNotFound when absent there too
            try:
                self.put(key, data, _guess_type(key))
            except StorageError:
                pass  # serving the file matters more than migrating it right now
            return data
        raise StorageNotFound("File not found")

    def delete(self, key):
        key = _clean_key(key)
        self._ensure()
        try:
            self._db().run("DELETE FROM stored_files WHERE storage_key=?", (key,))
        except Exception as e:
            raise StorageError(f"Database delete failed: {type(e).__name__}") from e
        if self.legacy is not None:
            self.legacy.delete(key)

    def delete_prefix(self, prefix):
        prefix = _clean_prefix(prefix)
        self._ensure()
        m = self._db()
        # Exact prefix comparison (not LIKE): "_" or "%" in a prefix must not
        # act as wildcards, so "cv/4/" can never match "cv/41/...".
        where = "substr(storage_key,1,?)=?"
        args = (len(prefix), prefix)
        try:
            row = m.one(f"SELECT COUNT(*) AS n FROM stored_files WHERE {where}", args)
            m.run(f"DELETE FROM stored_files WHERE {where}", args)
        except Exception as e:
            raise StorageError(f"Database prefix delete failed: {type(e).__name__}") from e
        removed = int(row["n"] or 0) if row else 0
        if self.legacy is not None:
            removed += self.legacy.delete_prefix(prefix)
        return removed

    def exists(self, key):
        key = _clean_key(key)
        self._ensure()
        if self._db().one("SELECT 1 AS present FROM stored_files WHERE storage_key=?", (key,)):
            return True
        return bool(self.legacy and self.legacy.exists(key))


# Deletes that failed (storage unreachable) are remembered and retried by the
# background sweeper instead of being forgotten, so no orphaned CV or photo
# bytes survive an account deletion or document prune.
PENDING_DELETE_SCHEMA = """CREATE TABLE IF NOT EXISTS storage_pending_deletes(
    target TEXT PRIMARY KEY, is_prefix INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, last_error TEXT NOT NULL DEFAULT '')"""


def _main():
    import main  # lazy: main imports this module
    return main


def record_pending_delete(target: str, *, is_prefix: bool = False, error: str = "") -> None:
    try:
        m = _main()
        m.run(PENDING_DELETE_SCHEMA)
        m.run("INSERT INTO storage_pending_deletes(target,is_prefix,attempts,created,last_error) VALUES (?,?,0,?,?) "
              "ON CONFLICT(target) DO UPDATE SET last_error=excluded.last_error",
              (target, 1 if is_prefix else 0, time.time(), str(error)[:200]))
    except Exception:  # pragma: no cover - last resort, keep the log line
        import logging
        logging.getLogger("skillbridge.storage").error("Could not record pending storage delete for %s", target)


def delete_or_defer(target: str, *, is_prefix: bool = False) -> bool:
    """Delete a key/prefix now; on a storage error remember it for a retry. True if done now."""
    try:
        storage = get_storage()
        if is_prefix:
            storage.delete_prefix(target)
        else:
            storage.delete(target)
        return True
    except (StorageError, NotImplementedError) as e:
        record_pending_delete(target, is_prefix=is_prefix, error=type(e).__name__)
        return False


def retry_pending_deletes(limit: int = 100) -> int:
    """Retry remembered deletes. Returns how many succeeded."""
    m = _main()
    m.run(PENDING_DELETE_SCHEMA)
    done = 0
    for row in m.allr("SELECT target,is_prefix,attempts FROM storage_pending_deletes ORDER BY created LIMIT ?", (limit,)):
        try:
            storage = get_storage()
            if int(row["is_prefix"] or 0):
                storage.delete_prefix(row["target"])
            else:
                storage.delete(row["target"])
        except (StorageError, NotImplementedError) as e:
            m.run("UPDATE storage_pending_deletes SET attempts=attempts+1,last_error=? WHERE target=?",
                  (type(e).__name__, row["target"]))
            continue
        m.run("DELETE FROM storage_pending_deletes WHERE target=?", (row["target"],))
        done += 1
    return done


_TYPES = {".pdf": "application/pdf", ".webp": "image/webp", ".txt": "text/plain", ".md": "text/markdown",
          ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def _guess_type(key: str) -> str:
    return next((t for ext, t in _TYPES.items() if key.lower().endswith(ext)), "application/octet-stream")


def _local_dir() -> str:
    return os.getenv("STORAGE_LOCAL_DIR") or str(Path(os.getenv("DB_PATH", "/data/skillbridge.db")).parent / "cv_files")


_instance: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    """Return the configured backend (created once per process)."""
    global _instance
    if _instance is None:
        backend = (os.getenv("STORAGE_BACKEND") or "database").strip().lower()
        if backend in ("database", "db"):
            legacy_dir = Path(_local_dir())
            _instance = DatabaseStorage(LocalStorage(legacy_dir) if legacy_dir.is_dir() else None)
        elif backend == "s3":
            _instance = S3Storage(
                bucket=os.getenv("S3_BUCKET", ""),
                region=os.getenv("S3_REGION", "auto"),
                endpoint_url=os.getenv("S3_ENDPOINT_URL", ""),
                access_key=os.getenv("S3_ACCESS_KEY_ID", ""),
                secret_key=os.getenv("S3_SECRET_ACCESS_KEY", ""),
                prefix=os.getenv("S3_PREFIX", ""),
            )
        elif backend == "local":
            _instance = LocalStorage(_local_dir())
        else:
            raise StorageError(f"Unknown STORAGE_BACKEND '{backend}' (use 'database', 'local' or 's3')")
    return _instance


def reset_storage_for_tests() -> None:
    global _instance
    _instance = None