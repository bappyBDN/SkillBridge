"""Meeting-provider seam for manual / Zoom interviews.

The company flow stores meeting details itself today. A real Zoom integration
(owner: Imran) can be dropped in later without touching the API, the database
or the candidate-facing page: implement ``MeetingProvider`` and register it in
``get_meeting_provider``.

Nothing here scores, judges or auto-decides anything.
"""
from __future__ import annotations

import os
import re
import time
from abc import ABC, abstractmethod


class MeetingError(ValueError):
    """Invalid meeting details (safe to show the company)."""


class MeetingProvider(ABC):
    name = "abstract"
    supports_auto_create = False

    @abstractmethod
    def validate(self, meeting_url: str, scheduled_at: str, note: str = "") -> dict:
        """Return the normalised details or raise ``MeetingError``."""

    def create_meeting(self, *, topic: str, scheduled_at: str, note: str = "") -> dict:
        """Create a provider-side meeting. The stub cannot do this."""
        raise MeetingError("This meeting provider cannot create meetings automatically")

    def describe(self) -> dict:
        return {"provider": self.name, "auto_create": self.supports_auto_create}


class StubMeetingProvider(MeetingProvider):
    """Manual provider: the company pastes a Zoom/Meet link and the time."""

    name = "stub"
    supports_auto_create = False

    def validate(self, meeting_url: str, scheduled_at: str, note: str = "") -> dict:
        url = (meeting_url or "").strip()
        when = (scheduled_at or "").strip()
        if not re.match(r"^https?://[^\s]+$", url) or len(url) > 500:
            raise MeetingError("A valid meeting URL is required")
        if not when or len(when) > 80:
            raise MeetingError("A scheduled time is required")
        return {"meeting_url": url, "scheduled_at": when,
                "note": (note or "").strip()[:2000], "provider": self.name,
                "created_at": time.time()}


def get_meeting_provider() -> MeetingProvider:
    """Return the configured provider. Only the stub ships today."""
    name = os.getenv("INTERVIEW_MEETING_PROVIDER", "stub").strip().lower()
    if name in ("", "stub", "manual"):
        return StubMeetingProvider()
    raise MeetingError("Unknown meeting provider: " + name)
