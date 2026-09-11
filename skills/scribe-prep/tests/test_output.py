import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import reportlab

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.root = self.folder / "state"
        self.output = self.root / "output"
        self.output.mkdir(parents=True)
        self.cards = self.output / "cards.json"
        self.pdf = self.output / "companion.pdf"

    def pdf_command(self, cards=None, output=None):
        return [sys.executable, str(SCRIPTS / "render_companion.py"), "--cards", str(cards or self.cards),
                "--output", str(output or self.pdf)]

    def render_pdf(self, cards=None, output=None):
        result = subprocess.run(self.pdf_command(cards, output), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def ledger(self, command, *args, now="2026-09-11T12:00:00Z"):
        result = subprocess.run([sys.executable, str(SCRIPTS / "scribe_state.py"), "--root", str(self.root),
                                 command, *map(str, args), "--now", now], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def json_file(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value))
        return path

    def ready_ledger(self):
        source = self.folder / "source.png"
        source.write_bytes(b"synthetic reviewed page")
        review = {"schema_version": 1, "notebook_id": "daily", "page_id": "page", "coverage": "complete",
                  "source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                             "kind": "manual_snapshot", "purpose": "live", "observed_at": "2026-09-11T12:00:00Z",
                             "authored_date": None, "active_until": "2026-09-12T00:00:00Z"},
                  "tasks": [{"id": "task", "text": "Check opening time", "status": "open", "mode": "context", "confidence": "clear"}]}
        self.ledger("observe", "--review", self.json_file("review.json", review))
        ticket = self.ledger("due")["tickets"][0]
        ready = {"notebook_id": "daily", "task_id": "task", "revision": ticket["revision"],
                 "status": "ready", "note": "Counter closes at five.", "time_sensitive": True,
                 "evidence": [{"reference": "https://example.test/counter", "observed_at": "2026-09-11T12:00:00Z",
                               "valid_until": "2026-09-11T13:00:00Z"}]}
        self.ledger("record", "--result", self.json_file("ready.json", ready))
        self.ledger("render")
        self.render_pdf()
        return review

    def test_pdf_waits_for_lock_then_reads_latest_cards(self):
        self.assertEqual(reportlab.Version, "4.4.9")
        first = {"cards": [{"task": "Synthetic task", "note": "Earlier verified note."}]}
        latest = {"cards": [{"task": "Synthetic task", "note": "Latest verified note."}]}
        self.cards.write_text(json.dumps(first))
        self.render_pdf()
        earlier = self.pdf.read_bytes()
        lock = os.open(self.output / ".output.lock", os.O_RDWR)
        process = None
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(self.pdf_command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(0.2)
            self.assertIsNone(process.poll(), "PDF command did not wait for the shared lock")
            self.assertEqual(self.pdf.read_bytes(), earlier)
            self.cards.write_text(json.dumps(latest))
        finally:
            os.close(lock)
        try:
            _, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, error)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        actual = self.pdf.read_bytes()
        self.assertNotEqual(actual, earlier)
        expected = self.folder / "expected"
        expected.mkdir()
        (expected / "cards.json").write_text(json.dumps(latest))
        self.render_pdf(expected / "cards.json", expected / "companion.pdf")
        self.assertEqual(actual, (expected / "companion.pdf").read_bytes())
        modified = self.pdf.stat().st_mtime_ns
        self.assertFalse(self.render_pdf()["changed"])
        self.assertEqual(self.pdf.stat().st_mtime_ns, modified)

    def test_delayed_ledger_render_observes_completion_before_publishing(self):
        review = self.ready_ledger()
        lock = os.open(self.output / ".output.lock", os.O_RDWR)
        process = None
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "scribe_state.py"), "--root", str(self.root),
                                        "render", "--now", "2026-09-11T12:05:00Z"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(0.2)
            self.assertIsNone(process.poll(), "Ledger command did not wait for the shared lock")
            review["source"]["observed_at"] = "2026-09-11T12:05:00Z"
            review["tasks"][0]["status"] = "done"
            self.ledger("observe", "--review", self.json_file("done.json", review), now="2026-09-11T12:05:00Z")
        finally:
            os.close(lock)
        try:
            _, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, error)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        self.assertEqual(json.loads(self.cards.read_text())["cards"], [])

    def test_expiry_retires_cards_during_a_queued_wake_and_pdf_retry_finishes_publication(self):
        self.ready_ledger()
        earlier_pdf = self.pdf.read_bytes()
        watch = self.root / "watch"
        watch.mkdir()
        (watch / "state.json").write_text(json.dumps({"delivery": {"kind": "queued"}}))
        self.ledger("render", now="2026-09-11T14:00:00Z")
        self.assertEqual(json.loads(self.cards.read_text())["cards"], [])
        self.assertEqual(self.pdf.read_bytes(), earlier_pdf)
        self.render_pdf()
        self.assertNotEqual(self.pdf.read_bytes(), earlier_pdf)
        self.assertEqual(json.loads((watch / "state.json").read_text()), {"delivery": {"kind": "queued"}})
        modified = self.pdf.stat().st_mtime_ns
        self.ledger("render", now="2026-09-11T14:00:00Z")
        self.assertFalse(self.render_pdf()["changed"])
        self.assertEqual(self.pdf.stat().st_mtime_ns, modified)

    def test_pdf_cannot_use_a_different_output_lock_directory(self):
        self.cards.write_text(json.dumps({"cards": []}))
        destination = self.folder / "elsewhere" / "companion.pdf"
        result = subprocess.run(self.pdf_command(output=destination), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must share the output directory", result.stderr)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
