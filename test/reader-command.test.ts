import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReader } from "../src/reader.js";

test("reader ownership spans orchestration and failure preserves existing data", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-reader-owner-"));
  const existing = join(root, "existing-private-state");
  await writeFile(existing, "preserve");
  const owner = new Database(join(root, "reader-ownership.sqlite3"), {
    create: true,
  });
  owner.exec("BEGIN EXCLUSIVE");
  try {
    await expect(
      runReader(
        { kind: "list" },
        root,
        "/missing/native-reader",
        new AbortController().signal,
      ),
    ).rejects.toThrow("busy");
    owner.close();
    await expect(
      runReader(
        { kind: "list" },
        root,
        "/missing/native-reader",
        new AbortController().signal,
      ),
    ).rejects.toThrow("network-error");
    const successor = new Database(join(root, "reader-ownership.sqlite3"));
    successor.exec("BEGIN EXCLUSIVE");
    successor.close();
    expect(await readFile(existing, "utf8")).toBe("preserve");
  } finally {
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
