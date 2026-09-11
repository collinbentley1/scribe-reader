#!/usr/bin/env -S python3 -B
"""Local reviewed-snapshot ledger. Performs no OCR, network calls, or external effects."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from datetime import date, datetime, timezone
from output_lock import output_lock

MEDIA = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf"}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def stamp(value):
    require(isinstance(value, str), "timestamp must be an ISO string with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("invalid timestamp") from None
    require(parsed.tzinfo is not None and parsed.utcoffset() is not None,
            "timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def identity(value, field):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), f"invalid {field}")
    return value


def load_json(path):
    def unique(pairs):
        output = {}
        for key, value in pairs:
            require(key not in output, f"duplicate JSON key: {key}")
            output[key] = value
        return output
    data = json.loads(Path(path).read_text(), object_pairs_hook=unique)
    require(isinstance(data, dict), "input must be a JSON object")
    return data


def atomically_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.read_bytes() == content:
        return
    fd, temporary = tempfile.mkstemp(prefix=".scribe-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Ledger:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "state.sqlite3", timeout=30)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL,
                source_hash TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL,
                payload TEXT NOT NULL);
        """)

    def snapshots(self):
        return [(key, json.loads(payload)) for key, payload in
                self.db.execute("SELECT id, payload FROM snapshots ORDER BY id")]

    def results(self):
        return [json.loads(row[0]) for row in
                self.db.execute("SELECT payload FROM results ORDER BY id")]

    def current(self):
        tasks = {}
        for snapshot_id, snapshot in self.snapshots():
            notebook, page = snapshot["notebook_id"], snapshot["page_id"]
            present = {task["id"] for task in snapshot["tasks"]}
            observations = [(task, "visible") for task in snapshot["tasks"]]
            for key, previous in list(tasks.items()):
                if key[0] == notebook and previous["page_id"] == page and key[1] not in present:
                    visibility = "removed" if snapshot["coverage"] == "complete" else "unknown"
                    observations.append((previous["task"], visibility))
            for task, visibility in observations:
                key = notebook, task["id"]
                previous = tasks.get(key)
                semantic = {name: value for name, value in task.items() if name != "anchor"}
                semantic["visibility"] = visibility
                semantic["purpose"] = snapshot["source"]["purpose"]
                fingerprint = digest(canonical(semantic).encode())
                if previous and fingerprint == previous["fingerprint"]:
                    revision = previous["revision"]
                else:
                    revision = digest(canonical([key, previous["revision"] if previous else None,
                                                 fingerprint]).encode())
                tasks[key] = {"notebook_id": notebook, "page_id": page, "task_id": task["id"],
                              "revision": revision, "fingerprint": fingerprint, "task": task,
                              "visibility": visibility, "snapshot_id": snapshot_id,
                              "source": snapshot["source"]}
        return tasks

    def scan(self, inbox):
        inbox = Path(inbox).expanduser().resolve()
        require(inbox.is_dir(), "inbox does not exist")
        require(not inbox.is_relative_to(self.root) and not self.root.is_relative_to(inbox),
                "inbox and managed state must be separate directories")
        accepted = {row[0] for row in self.db.execute("SELECT source_hash FROM snapshots")}
        artifacts = {item["path"] for result in self.results() for item in result.get("artifacts", [])}
        groups = {}
        for path in sorted(inbox.rglob("*")):
            if (not path.is_file() or path.is_symlink() or path.suffix.lower() not in MEDIA
                    or any(part.startswith(".") for part in path.relative_to(inbox).parts)
                    or str(path.resolve()) in artifacts):
                continue
            source_hash = digest(path.read_bytes())
            if source_hash not in accepted:
                groups.setdefault(source_hash, []).append(str(path))
        return {"unreviewed": [{"sha256": key, "paths": paths} for key, paths in groups.items()],
                "source_status": "local snapshot inbox; acquisition not checked"}

    def observe(self, review, now):
        require(review.get("schema_version") == 1, "schema_version must be 1")
        notebook = identity(review.get("notebook_id"), "notebook_id")
        page = identity(review.get("page_id"), "page_id")
        require(review.get("coverage") in {"complete", "partial"}, "invalid coverage")
        source = review.get("source")
        require(isinstance(source, dict), "source must be an object")
        require(source.get("kind") in ("manual_snapshot", "amazon_cloud_snapshot"),
                "source kind must be manual_snapshot or amazon_cloud_snapshot")
        require(source.get("purpose") in {"live", "reference"}, "source purpose must be live or reference")
        require(isinstance(source.get("path"), str), "source path required")
        path = Path(source["path"]).expanduser().resolve()
        require(path.is_file() and path.suffix.lower() in MEDIA, "source must be an existing image or PDF")
        require(not path.is_relative_to(self.root), "managed outputs cannot be imported as sources")
        body = path.read_bytes()
        source_hash = digest(body)
        require(source.get("sha256") == source_hash, "source hash does not match file")
        observed = stamp(source.get("observed_at"))
        active_until = stamp(source.get("active_until"))
        require(observed <= now, "observation is in the future")
        authored = source.get("authored_date")
        require("authored_date" in source, "authored_date must be explicit, or null if unknown")
        if authored is not None:
            require(isinstance(authored, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", authored),
                    "authored_date must be YYYY-MM-DD or null")
            date.fromisoformat(authored)
        tasks = review.get("tasks")
        require(isinstance(tasks, list), "tasks must be an array")
        normalized = []
        ids = set()
        for task in tasks:
            require(isinstance(task, dict), "task must be an object")
            task_id = identity(task.get("id"), "task id")
            require(task_id not in ids, "duplicate task id on page")
            ids.add(task_id)
            require(task.get("status") in {"open", "done", "uncertain"}, "invalid task status")
            require(task.get("mode") in {"context", "retrieve", "admin_draft", "skip"}, "invalid task mode")
            require(task.get("confidence") in {"clear", "uncertain"}, "invalid task confidence")
            require(isinstance(task.get("text"), str) and task["text"].strip(), "task text required")
            text = " ".join(task["text"].split())
            require(len(text) <= 2000, "task text too long")
            anchor = task.get("anchor")
            if anchor is not None:
                require(isinstance(anchor, list) and len(anchor) == 4 and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1
                    for v in anchor), "anchor must contain four normalized coordinates")
            access_revision = identity(task.get("access_revision", "initial"), "access_revision")
            authorization = task.get("access_authorization")
            require(authorization is None or (isinstance(authorization, str) and authorization.strip()),
                    "access_authorization must be a user-request reference")
            normalized.append({"id": task_id, "text": text, "status": task["status"],
                               "mode": task["mode"], "confidence": task["confidence"], "anchor": anchor,
                               "access_revision": access_revision, "access_authorization": authorization,
                               "dependency_revision": identity(task.get("dependency_revision", "initial"), "dependency_revision")})
        normalized.sort(key=lambda task: task["id"])
        payload = {"schema_version": 1, "notebook_id": notebook, "page_id": page,
                   "coverage": review["coverage"], "tasks": normalized,
                   "source": {"path": str(path), "sha256": source_hash, "kind": source["kind"],
                              "purpose": source["purpose"], "observed_at": iso(observed),
                              "active_until": iso(active_until), "authored_date": authored}}
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            supplied = {task["id"]: task for task in tasks}
            history = [(key, item) for key, item in self.snapshots()
                       if item["notebook_id"] == notebook and item["page_id"] == page]
            for snapshot_id, accepted in history:
                if accepted["source"]["observed_at"] != iso(observed):
                    continue
                replay = json.loads(canonical(payload))
                accepted_tasks = {task["id"]: task for task in accepted["tasks"]}
                for task in replay["tasks"]:
                    for field in ("access_revision", "access_authorization", "dependency_revision"):
                        if field not in supplied[task["id"]] and task["id"] in accepted_tasks:
                            task[field] = accepted_tasks[task["id"]].get(field)
                del replay["source"]["path"]
                replay_hash = digest(canonical(replay).encode())
                accepted_hash = self.db.execute("SELECT fingerprint FROM snapshots WHERE id=?", (snapshot_id,)).fetchone()[0]
                if replay_hash == accepted_hash:
                    return {"snapshot_id": snapshot_id, "duplicate": True}
            prior_tasks = self.current()
            for task in normalized:
                previous = prior_tasks.get((notebook, task["id"]))
                if previous:
                    require(previous["page_id"] == page or observed > stamp(previous["source"]["observed_at"]),
                            "task move is older than its current observation")
                    for field in ("access_revision", "access_authorization", "dependency_revision"):
                        if field not in supplied[task["id"]]:
                            task[field] = previous["task"].get(field)
                    if task["access_revision"] != previous["task"]["access_revision"]:
                        require(supplied[task["id"]].get("access_authorization"),
                                "changed access_revision requires new user authorization")
                require(task["access_revision"] == "initial" or task["access_authorization"] is not None,
                        "changed access_revision requires access_authorization from the user")
            identity_payload = json.loads(canonical(payload))
            del identity_payload["source"]["path"]
            fingerprint = digest(canonical(identity_payload).encode())
            found = self.db.execute("SELECT id FROM snapshots WHERE fingerprint=?", (fingerprint,)).fetchone()
            if found:
                return {"snapshot_id": found[0], "duplicate": True}
            if history:
                require(observed > stamp(history[-1][1]["source"]["observed_at"]),
                        "page observation must be newer than the accepted observation")
            stored = self.root / "sources" / (source_hash + path.suffix.lower())
            atomically_write(stored, body)
            payload["source"]["stored_path"] = str(stored)
            cursor = self.db.execute("INSERT INTO snapshots(fingerprint,source_hash,payload) VALUES(?,?,?)",
                                     (fingerprint, source_hash, canonical(payload)))
            snapshot_id = cursor.lastrowid
        return {"snapshot_id": snapshot_id, "duplicate": False}

    @staticmethod
    def eligible(task, now):
        return (task["visibility"] == "visible" and task["task"]["status"] == "open"
                and task["task"]["confidence"] == "clear" and task["task"]["mode"] != "skip"
                and task["source"]["purpose"] == "live"
                and now < stamp(task["source"]["active_until"]))

    @staticmethod
    def fresh(result, now):
        if result["status"] != "ready":
            return False
        for evidence in result["evidence"]:
            if evidence.get("valid_until") and now >= stamp(evidence["valid_until"]):
                return False
        for artifact in result["artifacts"]:
            path = Path(artifact["path"])
            if not path.is_file() or digest(path.read_bytes()) != artifact["sha256"]:
                return False
        return True

    def disposition(self, task, results, now):
        relevant = [result for result in results if result["notebook_id"] == task["notebook_id"]
                    and result["task_id"] == task["task_id"]]
        denied = any(result["status"] == "blocked" and result["reason"] == "access_denied"
                     and result["access_revision"] == task["task"]["access_revision"] for result in relevant)
        if denied:
            return "blocked", None
        matching = [result for result in relevant if result["revision"] == task["revision"]]
        if not matching:
            return "pending", None
        latest = matching[-1]
        if self.fresh(latest, now):
            return "ready", latest
        if latest["status"] == "blocked":
            return "blocked", latest
        if latest["status"] == "retry" and now < stamp(latest["retry_after"]):
            return "waiting", latest
        return "expired" if latest["status"] == "ready" else "retry", latest

    def due(self, now):
        results = self.results()
        tickets = []
        counts = {"inactive": 0, "blocked": 0, "waiting": 0, "ready": 0}
        for task in self.current().values():
            if not self.eligible(task, now):
                counts["inactive"] += 1
                continue
            status, _ = self.disposition(task, results, now)
            if status in {"pending", "expired", "retry"}:
                tickets.append({key: value for key, value in task.items() if key != "fingerprint"} | {"reason": status})
            else:
                counts[status] += 1
        return {"tickets": tickets, "counts": counts}

    def inspect(self, now, notebook=None, page=None):
        results = self.results()
        tasks = []
        for task in self.current().values():
            if (notebook is not None and task["notebook_id"] != notebook
                    or page is not None and task["page_id"] != page):
                continue
            eligible = self.eligible(task, now)
            state = self.disposition(task, results, now)[0] if eligible else "inactive"
            tasks.append({key: value for key, value in task.items() if key != "fingerprint"}
                         | {"eligible": eligible, "preparation_state": state})
        tasks.sort(key=lambda task: (task["notebook_id"], task["page_id"], task["task_id"]))
        return {"tasks": tasks}

    def record(self, incoming, now):
        notebook = identity(incoming.get("notebook_id"), "notebook_id")
        task_id = identity(incoming.get("task_id"), "task_id")
        require(incoming.get("status") in {"ready", "retry", "blocked"}, "invalid result status")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            task = self.current().get((notebook, task_id))
            require(task is not None and task["revision"] == incoming.get("revision"), "stale or unknown task revision")
            require(self.eligible(task, now), "task is no longer eligible")
            payload = {"notebook_id": notebook, "task_id": task_id, "revision": task["revision"],
                       "status": incoming["status"], "access_revision": task["task"]["access_revision"]}
            if incoming["status"] == "ready":
                note = incoming.get("note")
                require(isinstance(note, str) and note.strip() == note and note, "ready note required")
                require(len(note) <= 96 and len(note.splitlines()) <= 2 and "\r" not in note,
                        "note must be at most 96 characters and two lines")
                require(type(incoming.get("time_sensitive")) is bool, "time_sensitive must be explicit")
                evidence = incoming.get("evidence")
                require(isinstance(evidence, list) and evidence, "ready result requires evidence")
                checked = []
                for item in evidence:
                    require(isinstance(item, dict) and isinstance(item.get("reference"), str)
                            and item["reference"].strip(), "evidence reference required")
                    observed = stamp(item.get("observed_at"))
                    require(observed <= now, "evidence observation is in the future")
                    expiry = stamp(item["valid_until"]) if item.get("valid_until") else None
                    require(expiry is None or (expiry > observed and expiry > now), "evidence is already expired")
                    checked.append({"reference": item["reference"], "observed_at": iso(observed),
                                    "valid_until": iso(expiry) if expiry else None})
                require(not incoming["time_sensitive"] or any(item["valid_until"] for item in checked),
                        "time-sensitive result requires expiry")
                artifacts = incoming.get("artifacts", [])
                require(isinstance(artifacts, list), "artifacts must be an array of paths")
                saved = []
                for artifact in artifacts:
                    require(isinstance(artifact, str), "artifact must be a path string")
                    path = Path(artifact).expanduser().resolve()
                    require(path.is_file(), "claimed artifact does not exist")
                    saved.append({"path": str(path), "sha256": digest(path.read_bytes())})
                delivery = incoming.get("delivery", {"stage": "local"})
                require(isinstance(delivery, dict) and delivery.get("stage") in
                        {"local", "submitted", "visible", "uncertain"}, "invalid delivery stage")
                if delivery["stage"] != "local":
                    require(isinstance(delivery.get("reference"), str) and delivery["reference"], "delivery receipt required")
                    require(stamp(delivery.get("observed_at")) <= now, "invalid delivery observation")
                payload.update(note=note, time_sensitive=incoming["time_sensitive"], evidence=checked,
                               artifacts=saved, delivery=delivery)
            else:
                reason = incoming.get("reason")
                require(isinstance(reason, str) and reason.strip(), "reason required")
                payload["reason"] = reason
                if incoming["status"] == "retry":
                    require(reason != "access_denied", "access denial must stay blocked")
                    retry = stamp(incoming.get("retry_after"))
                    require(retry > now, "retry_after must be in the future")
                    payload["retry_after"] = iso(retry)
            fingerprint = digest(canonical(payload).encode())
            found = self.db.execute("SELECT id FROM results WHERE fingerprint=?", (fingerprint,)).fetchone()
            if found:
                return {"result_id": found[0], "duplicate": True}
            state, _ = self.disposition(task, self.results(), now)
            require(state != "blocked", "task is blocked until reviewed access or dependency changes")
            payload["recorded_at"] = iso(now)
            cursor = self.db.execute("INSERT INTO results(fingerprint,payload) VALUES(?,?)", (fingerprint, canonical(payload)))
            result_id = cursor.lastrowid
        return {"result_id": result_id, "duplicate": False}

    def render(self, now):
        with output_lock(self.root / "output"), self.db:
            self.db.execute("BEGIN IMMEDIATE")
            return self._render_current(now)

    def _render_current(self, now):
        cards = []
        results = self.results()
        for task in self.current().values():
            if not self.eligible(task, now):
                continue
            status, result = self.disposition(task, results, now)
            if status == "ready":
                cards.append({"notebook_id": task["notebook_id"], "page_id": task["page_id"],
                              "task_id": task["task_id"], "task": task["task"]["text"],
                              "revision": task["revision"], "note": result["note"],
                              "source": task["source"], "evidence": result["evidence"],
                              "artifacts": result["artifacts"], "delivery": result["delivery"]})
        cards.sort(key=lambda card: (card["notebook_id"], card["page_id"], card["task_id"]))
        def escape(text):
            return re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", text)
        lines = ["# Scribe preparation", "", "Companion notes from reviewed snapshots. The handwritten notebook is unchanged.", ""]
        for card in cards:
            lines += [f"- {escape(card['task'])} · {escape(card['notebook_id'])}/{escape(card['page_id'])}",
                      "  " + escape(card["note"]).replace("\n", "  \n  "), ""]
        if not cards:
            lines += ["No current verified notes.", ""]
        folder = self.root / "output"
        atomically_write(folder / "cards.json", (json.dumps({"cards": cards}, indent=2, ensure_ascii=False) + "\n").encode())
        atomically_write(folder / "companion.md", "\n".join(lines).encode())
        return {"cards": len(cards), "markdown": str(folder / "companion.md"), "json": str(folder / "cards.json")}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="managed state directory, separate from inbox")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("scan", "inspect", "observe", "due", "record", "render"):
        command = commands.add_parser(name)
        command.add_argument("--now", help="explicit ISO timestamp for deterministic verification")
        if name == "scan":
            command.add_argument("--inbox", type=Path, required=True)
        elif name == "inspect":
            command.add_argument("--notebook-id", help="limit prior state to one stable notebook ID")
            command.add_argument("--page-id", help="limit prior state to one stable page ID")
        elif name == "observe":
            command.add_argument("--review", type=Path, required=True)
        elif name == "record":
            command.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    try:
        now = stamp(args.now) if args.now else datetime.now(timezone.utc)
        ledger = Ledger(args.root)
        if args.command == "scan":
            output = ledger.scan(args.inbox)
        elif args.command == "inspect":
            output = ledger.inspect(now, args.notebook_id, args.page_id)
        elif args.command == "observe":
            output = ledger.observe(load_json(args.review), now)
        elif args.command == "record":
            output = ledger.record(load_json(args.result), now)
        else:
            output = getattr(ledger, args.command)(now)
        print(json.dumps(output, ensure_ascii=False))
        ledger.db.close()
        return 0
    except (ValueError, OSError, sqlite3.Error, TypeError, KeyError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
