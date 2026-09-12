import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/scribe_state.py"
NOW = "2026-09-11T12:00:00Z"


class StateCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.root = self.folder / "state"
        self.inbox = self.folder / "inbox"
        self.inbox.mkdir()
        self.source = self.inbox / "capture.pdf"
        self.source.write_bytes(b"synthetic reviewed capture; no OCR runs")
        self.clock = NOW
        self.sequence = 0

    def command(self, name, *args, success=True):
        process = subprocess.run([sys.executable, "-B", str(SCRIPT), "--root", str(self.root), name,
                                  *map(str, args), "--now", self.clock], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0 if success else 2, process.stderr)
        return json.loads(process.stdout if success else process.stderr)

    def json_file(self, value):
        self.sequence += 1
        path = self.folder / f"input-{self.sequence}.json"
        path.write_text(json.dumps(value))
        return path

    def task(self, task_id="post", **changes):
        return {"id": task_id, "text": "Look up post office closing time", "status": "open",
                "mode": "context", "confidence": "clear", **changes}

    def review(self, tasks=None, **changes):
        return {"schema_version": 1, "notebook_id": "daily", "page_id": "p81", "coverage": "complete",
                "source": {"path": str(self.source), "sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                           "kind": "manual_snapshot", "purpose": "live", "observed_at": self.clock,
                           "authored_date": None, "active_until": "2026-09-12T12:00:00Z"},
                "tasks": [self.task()] if tasks is None else tasks, **changes}

    def observe(self, review=None, success=True):
        return self.command("observe", "--review", self.json_file(review or self.review()), success=success)

    def tickets(self):
        return self.command("due")["tickets"]

    def ready(self, ticket=None, **changes):
        ticket = ticket or self.tickets()[0]
        return {"notebook_id": ticket["notebook_id"], "task_id": ticket["task_id"],
                "revision": ticket["revision"], "status": "ready", "note": "Counter closes at 5 pm today.",
                "time_sensitive": True, "evidence": [{"reference": "https://example.test/postal-counter",
                  "observed_at": self.clock, "valid_until": "2026-09-11T21:00:00Z"}], **changes}

    def record(self, result, success=True):
        return self.command("record", "--result", self.json_file(result), success=success)

    def cards(self):
        output = self.command("render")
        return json.loads(Path(output["json"]).read_text())["cards"]

    def later(self):
        self.clock = "2026-09-11T12:05:00Z"

    def test_scan_repeats_until_review_and_groups_duplicate_files(self):
        (self.inbox / "copy.pdf").write_bytes(self.source.read_bytes())
        first = self.command("scan", "--inbox", self.inbox)
        self.assertEqual(first["source_status"], "local snapshot inbox; acquisition not checked")
        self.assertEqual(len(first["unreviewed"]), 1)
        self.assertEqual(len(first["unreviewed"][0]["paths"]), 2)
        self.assertEqual(first, self.command("scan", "--inbox", self.inbox))
        self.observe()
        self.assertEqual(self.command("scan", "--inbox", self.inbox)["unreviewed"], [])

    def test_cloud_source_preserves_kind_identity_and_preparation(self):
        tasks = [self.task("ready"), self.task("done", status="done"), self.task("blocked")]
        self.observe(self.review(tasks))
        for ticket in self.tickets():
            result = self.ready(ticket)
            if ticket["task_id"] == "blocked":
                result.update(status="blocked", reason="access_denied")
            self.record(result)
        before = self.command("inspect")["tasks"]
        self.later()
        self.source = self.inbox / "cloud-page.png"
        self.source.write_bytes(b"synthetic reviewed cloud page; same visible tasks")
        review = self.review(tasks)
        review["source"]["kind"] = "amazon_cloud_snapshot"
        accepted = self.observe(review)
        after = self.command("inspect")["tasks"]
        self.assertEqual([task["task_id"] for task in after], ["blocked", "done", "ready"])
        self.assertEqual([task["revision"] for task in after], [task["revision"] for task in before])
        self.assertEqual([task["preparation_state"] for task in after], ["blocked", "inactive", "ready"])
        self.assertTrue(all(task["source"]["kind"] == "amazon_cloud_snapshot" for task in after))
        self.assertEqual(self.tickets(), [])
        cards = self.cards()
        self.assertEqual([card["task_id"] for card in cards], ["ready"])
        self.assertEqual(cards[0]["note"], "Counter closes at 5 pm today.")
        renamed = self.inbox / "renamed-cloud-page.png"
        renamed.write_bytes(self.source.read_bytes())
        review["source"]["path"] = str(renamed)
        duplicate = self.observe(review)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["snapshot_id"], accepted["snapshot_id"])
        self.assertEqual(self.command("scan", "--inbox", self.inbox)["unreviewed"], [])

    def test_unknown_source_kinds_are_rejected_without_accepting_review(self):
        for kind in ("cloud_snapshot", "", None, [], {}):
            with self.subTest(kind=kind):
                review = self.review()
                review["source"]["kind"] = kind
                failure = self.observe(review, success=False)
                self.assertEqual(failure["error"],
                                 "source kind must be manual_snapshot or amazon_cloud_snapshot")
                self.assertEqual(self.command("inspect")["tasks"], [])
                self.assertEqual(len(self.command("scan", "--inbox", self.inbox)["unreviewed"]), 1)

    def test_duplicate_renamed_export_and_semantically_unchanged_rows(self):
        review = self.review()
        first = self.observe(review)
        ticket = self.tickets()[0]
        copy = self.inbox / "renamed.pdf"
        copy.write_bytes(self.source.read_bytes())
        review["source"]["path"] = str(copy)
        duplicate = self.observe(review)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["snapshot_id"], duplicate["snapshot_id"])
        self.record(self.ready(ticket))
        self.later()
        self.source.write_bytes(b"new export bytes, same visible content")
        self.observe(self.review([self.task(text="  Look up  post office closing time  ", anchor=[.1, .2, .8, .3])]))
        self.assertEqual(self.tickets(), [])
        self.assertEqual(self.cards()[0]["revision"], ticket["revision"])

    def test_meaningful_text_change_invalidates_ready(self):
        self.observe()
        old = self.ready()
        self.record(old)
        self.later()
        self.observe(self.review([self.task(text="Look up staffed passport counter closing time")]))
        self.assertNotEqual(self.tickets()[0]["revision"], old["revision"])
        self.assertEqual(self.cards(), [])
        self.record(old, success=False)

    def test_done_and_reopened_task_needs_new_preparation(self):
        self.observe()
        old = self.ready()
        self.record(old)
        self.later()
        self.observe(self.review([self.task(status="done")]))
        self.assertEqual(self.tickets(), [])
        self.assertEqual(self.cards(), [])
        self.record(old, success=False)
        self.clock = "2026-09-11T12:10:00Z"
        self.observe()
        self.assertNotEqual(self.tickets()[0]["revision"], old["revision"])
        self.assertEqual(self.cards(), [])

    def test_uncertain_and_trivial_tasks_are_silent(self):
        self.observe(self.review([self.task("done", status="done"), self.task("unclear", status="uncertain"),
                                  self.task("uncertain-text", confidence="uncertain"), self.task("routine", mode="skip")]))
        self.assertEqual(self.tickets(), [])
        self.assertEqual(self.cards(), [])

    def test_old_photo_expiry_and_reference_sources_are_inactive(self):
        review = self.review()
        review["source"]["active_until"] = "2026-09-10T12:00:00Z"
        review["source"]["authored_date"] = "2026-09-01"
        self.observe(review)
        self.assertEqual(self.tickets(), [])
        self.later()
        review = self.review()
        review["source"]["purpose"] = "reference"
        self.observe(review)
        self.assertEqual(self.tickets(), [])

    def test_unchanged_source_keeps_retry_due(self):
        self.observe()
        result = self.ready()
        result.update(status="retry", reason="temporary source failure", retry_after="2026-09-11T13:00:00Z")
        self.record(result)
        self.assertEqual(self.tickets(), [])
        self.clock = "2026-09-11T13:01:00Z"
        self.assertEqual(self.tickets()[0]["reason"], "retry")
        self.assertEqual(self.command("scan", "--inbox", self.inbox)["unreviewed"], [])

    def test_inspect_preserves_ready_done_and_blocked_identity_for_next_review(self):
        self.observe(self.review([self.task("ready"), self.task("done", status="done"), self.task("blocked")]))
        for ticket in self.tickets():
            result = self.ready(ticket)
            if ticket["task_id"] == "blocked":
                result.update(status="blocked", reason="access_denied")
            self.record(result)
        inspected = self.command("inspect", "--notebook-id", "daily", "--page-id", "p81")["tasks"]
        self.assertEqual([task["task_id"] for task in inspected], ["blocked", "done", "ready"])
        self.assertEqual([task["preparation_state"] for task in inspected], ["blocked", "inactive", "ready"])
        self.assertTrue(all(task["revision"] and task["source"]["sha256"] for task in inspected))
        self.assertEqual(inspected[0]["task"]["access_revision"], "initial")
        self.assertEqual(inspected[1]["task"]["status"], "done")
        self.assertEqual(self.tickets(), [])
        self.assertEqual([card["task_id"] for card in self.cards()], ["ready"])
        self.assertEqual(self.command("inspect", "--page-id", "missing")["tasks"], [])

    def test_expired_evidence_retires_note_and_becomes_due(self):
        self.observe()
        self.record(self.ready())
        self.assertEqual(len(self.cards()), 1)
        self.clock = "2026-09-11T21:00:00Z"
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.tickets()[0]["reason"], "expired")
        self.clock = "2026-09-12T12:00:00Z"
        self.assertEqual(self.tickets(), [])

    def test_partial_absence_holds_tasks_and_reobservation_resets_readiness(self):
        self.observe(self.review([self.task("post"), self.task("lease", text="Email lease")]))
        results = [self.ready(ticket, note="Source material ready.", time_sensitive=False) for ticket in self.tickets()]
        for result in results:
            self.record(result)
        self.later()
        self.observe(self.review([self.task("post")], coverage="partial"))
        self.assertEqual([card["task_id"] for card in self.cards()], ["post"])
        self.assertEqual(self.tickets(), [])
        self.record(results[0] if results[0]["task_id"] == "lease" else results[1], success=False)
        self.clock = "2026-09-11T12:10:00Z"
        self.observe(self.review([self.task("post"), self.task("lease", text="Email lease")]))
        self.assertEqual([ticket["task_id"] for ticket in self.tickets()], ["lease"])

    def test_complete_absence_removes_card_without_marking_task_done(self):
        self.observe()
        self.record(self.ready())
        self.later()
        self.observe(self.review([]))
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.tickets(), [])

    def test_same_text_separate_ids_and_page_move(self):
        self.observe(self.review([self.task("person-a"), self.task("person-b")]))
        self.assertEqual(len(self.tickets()), 2)
        ticket = self.tickets()[0]
        self.record(self.ready(ticket))
        self.later()
        self.observe(self.review([self.task(ticket["task_id"])], page_id="p82"))
        card = self.cards()[0]
        self.assertEqual(card["page_id"], "p82")
        self.assertEqual(card["revision"], ticket["revision"])

    def test_access_denial_survives_export_and_text_changes(self):
        self.observe()
        result = self.ready()
        result.update(status="blocked", reason="access_denied")
        receipt = self.record(result)
        self.assertEqual(self.record(result)["result_id"], receipt["result_id"])
        self.later()
        self.observe(self.review([self.task(text="Check postal counter hours")]))
        self.assertEqual(self.tickets(), [])
        self.clock = "2026-09-11T12:10:00Z"
        self.observe(self.review([self.task(text="Check postal counter hours", access_revision="user-enabled-2",
                                            access_authorization="User explicitly authorized UI fallback in the current thread.")]))
        self.assertEqual(len(self.tickets()), 1)

    def test_other_block_waits_for_reviewed_dependency_change(self):
        self.observe()
        result = self.ready()
        result.update(status="blocked", reason="document not yet shared")
        self.record(result)
        self.assertEqual(self.tickets(), [])
        self.later()
        self.observe(self.review([self.task(dependency_revision="shared-2")]))
        self.assertEqual(len(self.tickets()), 1)

    def test_cross_page_older_observation_cannot_reopen_completed_task(self):
        self.observe()
        self.later()
        self.observe(self.review([self.task(status="done")], page_id="p82"))
        stale = self.review(page_id="p81")
        stale["source"]["observed_at"] = "2026-09-11T12:01:00Z"
        self.observe(stale, success=False)
        current = self.command("inspect")["tasks"][0]
        self.assertEqual((current["page_id"], current["task"]["status"]), ("p82", "done"))
        self.assertEqual(self.tickets(), [])

    def test_replaying_accepted_page_after_move_is_noop(self):
        original = self.review()
        first = self.observe(original)
        self.later()
        self.observe(self.review([self.task(status="done")], page_id="p82"))
        before = self.command("inspect")
        self.assertEqual(self.observe(original), {"snapshot_id": first["snapshot_id"], "duplicate": True})
        self.assertEqual(self.command("inspect"), before)
        self.assertEqual(self.tickets(), [])

    def test_replaying_review_with_inherited_access_keeps_later_authorization(self):
        def authorization(revision):
            return self.task(access_revision=revision, access_authorization=f"User authorized {revision}.")
        self.observe(self.review([authorization("route-1")]))
        self.later()
        inherited = self.review(page_id="p82")
        accepted = self.observe(inherited)
        self.clock = "2026-09-11T12:10:00Z"
        self.observe(self.review([authorization("route-2")], page_id="p83"))
        before = self.command("inspect")
        replay = self.observe(inherited)
        self.assertEqual(replay, {"snapshot_id": accepted["snapshot_id"], "duplicate": True})
        self.assertEqual(self.command("inspect"), before)
        self.assertEqual(before["tasks"][0]["task"]["access_revision"], "route-2")

    def test_omitted_access_fields_preserve_denial_and_authorization(self):
        fields = {"access_revision": "ui-user-authorized", "access_authorization": "User requested UI fallback.",
                  "dependency_revision": "document-2"}
        self.observe(self.review([self.task(**fields)]))
        result = self.ready()
        result.update(status="blocked", reason="access_denied")
        self.record(result)
        self.later()
        self.observe(self.review([self.task()]))
        current = self.command("inspect")["tasks"][0]
        for field, value in fields.items():
            self.assertEqual(current["task"][field], value)
        self.assertEqual(self.tickets(), [])
        self.clock = "2026-09-11T12:10:00Z"
        self.observe(self.review([self.task(access_revision="initial")]), success=False)
        self.assertEqual(self.tickets(), [])

    def test_artifacts_are_verified_and_invalidated_on_changes(self):
        self.observe()
        artifact = self.folder / "lease.pdf"
        result = self.ready(artifacts=[str(artifact)])
        self.record(result, success=False)
        artifact.write_bytes(b"lease scan fixture")
        self.record(result)
        self.assertEqual(len(self.cards()), 1)
        artifact.write_bytes(b"edited lease fixture")
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.tickets()[0]["reason"], "expired")

    def test_bad_review_is_atomic_and_stale_observation_is_rejected(self):
        self.observe()
        before = self.tickets()
        self.later()
        for alteration in ("hash", "timezone", "duplicate"):
            bad = self.review()
            if alteration == "hash":
                bad["source"]["sha256"] = "bad"
            elif alteration == "timezone":
                bad["source"]["observed_at"] = "2026-09-11T12:01:00"
            else:
                bad["tasks"].append(self.task())
            self.observe(bad, success=False)
        self.assertEqual(self.tickets(), before)
        old = self.review()
        old["source"]["observed_at"] = "2026-09-11T11:59:00Z"
        self.observe(old, success=False)
        corrupt = self.folder / "corrupt.json"
        corrupt.write_text('{"schema_version":1,"schema_version":2}')
        self.command("observe", "--review", corrupt, success=False)
        self.assertEqual(self.tickets(), before)

    def test_ready_validation_requires_evidence_expiry_and_compact_note(self):
        self.observe()
        for changes in ({"note": "x" * 97}, {"note": "one\ntwo\nthree"}, {"evidence": []},
                        {"evidence": [{"reference": "fixture", "observed_at": NOW}]},
                        {"delivery": {"stage": "visible"}}):
            self.record(self.ready(**changes), success=False)
        self.assertEqual(len(self.tickets()), 1)

    def test_duplicate_ready_and_unchanged_render_do_not_create_output_churn(self):
        self.observe()
        result = self.ready()
        first = self.record(result)
        self.assertEqual(self.record(result)["result_id"], first["result_id"])
        output = self.command("render")
        before = {key: Path(output[key]).stat().st_mtime_ns for key in ("markdown", "json")}
        self.later()
        self.command("render")
        self.assertEqual(before, {key: Path(output[key]).stat().st_mtime_ns for key in before})
        self.command("scan", "--inbox", self.root / "output", success=False)
        self.command("scan", "--inbox", self.folder, success=False)
        self.assertEqual(self.command("scan", "--inbox", self.inbox)["unreviewed"], [])

    def test_concurrent_completion_and_preparation_never_show_stale_note(self):
        self.observe()
        result = self.ready()
        self.later()
        review = self.review([self.task(status="done")])
        commands = [("observe", "--review", self.json_file(review)), ("record", "--result", self.json_file(result))]
        processes = [subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--root", str(self.root), name,
                                      flag, str(path), "--now", self.clock], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True) for name, flag, path in commands]
        outputs = [process.communicate(timeout=30) for process in processes]
        self.assertEqual(processes[0].returncode, 0, outputs)
        self.assertIn(processes[1].returncode, (0, 2), outputs)
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.tickets(), [])

    def test_render_publication_serializes_with_completion(self):
        self.observe()
        self.record(self.ready())
        output = self.root / "output"
        output.mkdir()
        fifo = output / "cards.json"
        os.mkfifo(fifo)
        renderer = subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--root", str(self.root), "render",
                                     "--now", self.clock], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        writer = None
        completion = None
        try:
            deadline = time.monotonic() + 10
            while writer is None and time.monotonic() < deadline:
                try:
                    writer = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                except OSError:
                    time.sleep(.02)
            self.assertIsNotNone(writer, "render did not reach its publication boundary")
            self.later()
            review = self.json_file(self.review([self.task(status="done")]))
            completion = subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--root", str(self.root), "observe",
                                           "--review", str(review), "--now", self.clock],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            with self.assertRaises(subprocess.TimeoutExpired):
                completion.communicate(timeout=.5)
            os.write(writer, b"{}")
            os.close(writer)
            writer = None
            self.assertEqual(renderer.communicate(timeout=10)[1], "")
            self.assertEqual(completion.communicate(timeout=10)[1], "")
            self.assertEqual(renderer.returncode, 0)
            self.assertEqual(completion.returncode, 0)
            self.assertEqual(self.cards(), [])
        finally:
            if writer is not None:
                os.close(writer)
            for process in (renderer, completion):
                if process is not None and process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()
