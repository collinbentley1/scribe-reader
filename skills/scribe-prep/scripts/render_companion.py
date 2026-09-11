#!/usr/bin/env -S python3 -B
"""Render ledger cards as a quiet, readable companion PDF. No delivery."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
from xml.sax.saxutils import escape

from output_lock import output_lock
from scribe_state import atomically_write

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default="Scribe preparation")
    parser.add_argument("--subtitle", default="Companion notes · original handwriting unchanged")
    args = parser.parse_args()
    if args.cards.resolve().parent != args.output.resolve().parent:
        parser.error("cards and PDF must share the output directory")
    with output_lock(args.cards.resolve().parent):
        data = json.loads(args.cards.read_text())
        cards = data["cards"]
        if not isinstance(cards, list):
            parser.error("cards must be an array")
        title = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=22, leading=27, spaceAfter=7)
        subtitle = ParagraphStyle("subtitle", fontName="Helvetica", fontSize=11, leading=15, textColor=colors.HexColor("#555555"))
        label = ParagraphStyle("label", fontName="Helvetica-Bold", fontSize=12, leading=16, spaceAfter=5)
        note = ParagraphStyle("note", fontName="Helvetica", fontSize=18, leading=24)
        flow = [Paragraph(escape(args.title), title), Paragraph(escape(args.subtitle), subtitle), Spacer(1, 30)]
        for card in cards:
            text = card["note"]
            if not isinstance(text, str) or not text.strip() or len(text) > 96 or len(text.splitlines()) > 2:
                parser.error("each note must be nonempty, at most 96 characters, and at most two lines")
            flow.append(KeepTogether([
                Paragraph(escape(card["task"]), label),
                Paragraph(escape(text).replace("\n", "<br/>"), note),
                Spacer(1, 26),
            ]))
        if not cards:
            flow.append(Paragraph("No current verified preparation notes.", note))
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=(612, 792), rightMargin=44, leftMargin=44,
                                topMargin=42, bottomMargin=42, title=args.title, author="Scribe Reader",
                                invariant=1)
        doc.build(flow)
        content = buffer.getvalue()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        changed = not args.output.exists() or args.output.read_bytes() != content
        if changed:
            atomically_write(args.output, content)
        print(json.dumps({"path": str(args.output.resolve()), "changed": changed,
                          "sha256": hashlib.sha256(content).hexdigest(), "cards": len(cards)}))


if __name__ == "__main__":
    main()
