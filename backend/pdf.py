"""Minimal dependency-free PDF writer.

Only what TalentForge needs: render plain text (a CV) into a valid PDF 1.4
document that any viewer can open. Standard Helvetica is used, so non-Latin
scripts cannot be embedded; characters outside ASCII/Latin-1 are replaced with
"?". That is acceptable for a stored preview because the original upload is kept
alongside it.
"""
from __future__ import annotations

import textwrap
import zlib

PAGE_WIDTH = 595  # A4 at 72 dpi
PAGE_HEIGHT = 842
MARGIN = 56
LINE_HEIGHT = 14
FONT_SIZE = 10
MAX_LINES = int((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT)


def _escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _latin1(text: str) -> str:
    out = []
    for ch in text:
        try:
            ch.encode("latin-1")
            out.append(ch)
        except UnicodeEncodeError:
            out.append("?")
    return "".join(out)


def _wrap(text: str, width: int = 92) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        raw = raw.replace("\t", "    ")
        if not raw.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(raw, width=width, break_long_words=True) or [""])
    return lines or [""]


def _content_stream(lines: list[str]) -> bytes:
    parts = ["BT", f"/F1 {FONT_SIZE} Tf", f"{MARGIN} {PAGE_HEIGHT - MARGIN} Td", f"{LINE_HEIGHT} TL"]
    for line in lines:
        parts.append(f"({_escape(_latin1(line))}) Tj")
        parts.append("T*")
    parts.append("ET")
    return "\n".join(parts).encode("latin-1", "replace")


def text_to_pdf(text: str, *, title: str = "Curriculum Vitae") -> bytes:
    """Return a PDF document containing ``text``."""
    lines = _wrap(text or "")
    pages = [lines[i:i + MAX_LINES] for i in range(0, len(lines), MAX_LINES)] or [[]]

    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    pages_id_placeholder = len(objects) + 1 + 2 * len(pages)
    page_ids = []
    for index, page_lines in enumerate(pages):
        stream = zlib.compress(_content_stream(page_lines))
        content_id = add(
            b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n"
            + stream + b"\nendstream"
        )
        page_id = add(
            (
                f"<< /Type /Page /Parent {pages_id_placeholder} 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>"
            ).encode()
        )
        page_ids.append(page_id)

    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    # The pages tree object must be the id we promised above.
    assert len(objects) + 1 == pages_id_placeholder, (len(objects), pages_id_placeholder)
    pages_id = add(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode())
    assert pages_id == pages_id_placeholder
    catalog_id = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
    info_id = add(f"<< /Title ({_escape(_latin1(title))}) /Producer (TalentForge) >>".encode())

    buffer = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(buffer))
        buffer += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(buffer)
    buffer += f"xref\n0 {len(objects) + 1}\n".encode()
    buffer += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        buffer += f"{offset:010d} 00000 n \n".encode()
    buffer += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R /Info {info_id} 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(buffer)
