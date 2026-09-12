import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Account } from "./account.js";
import { HELP, type Command } from "./cli.js";
import { LIMITS, parseOpen, ReaderError, safeShape } from "./domain.js";
import { PROTOCOL } from "./protocol.js";
import { syncNotebook } from "./snapshots.js";

export async function runReader(
  command: Command,
  root: string,
  executable: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (command.kind === "help") return HELP;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(
    abort,
    command.kind === "login" ? 900_000 : LIMITS.syncMs,
  );
  let account: Account | undefined;
  let ownership: Database | undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    ownership = new Database(join(root, "reader-ownership.sqlite3"), {
      create: true,
    });
    try {
      ownership.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      throw new ReaderError("busy");
    }
    account = await Account.connect(
      executable,
      controller.signal,
      command.kind === "login",
    );
    if (command.kind === "login") {
      await account.login();
      return { kind: "login-confirmed", evidence: "parsed-notebook-list" };
    }
    if (command.kind === "list")
      return { kind: "notebooks-listed", notebooks: await account.list() };
    if (command.kind === "probe") {
      const directory = join(root, "probes", randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const raw = await account.openRaw(command.notebookId);
      await writeFile(
        join(directory, "metadata-shape.json"),
        JSON.stringify(safeShape(raw), null, 2),
        { mode: 0o600 },
      );
      let opened;
      try {
        opened = parseOpen(raw);
      } catch {
        return { kind: "probe-metadata-unsupported", directory };
      }
      if (command.ordinal > opened.metadata.totalPages)
        throw new ReaderError("invalid-page");
      const page = command.ordinal - 1,
        bytes = await account.render(page, opened.token);
      await writeFile(join(directory, "response.tar"), bytes, { mode: 0o600 });
      const receipt = {
        kind: "probe-captured-unverified",
        metadata: opened.metadata,
        ordinal: command.ordinal,
        requestRange: { start: page, end: page },
        bytes: bytes.length,
        directory,
      };
      await writeFile(
        join(directory, "receipt.json"),
        JSON.stringify(receipt, null, 2),
        { mode: 0o600 },
      );
      return receipt;
    }
    if (!PROTOCOL.verified) throw new ReaderError("protocol-unverified");
    return await syncNotebook({
      account,
      root,
      notebookId: command.notebookId,
      full: command.full,
      signal: controller.signal,
    });
  } catch (error) {
    throw error instanceof ReaderError
      ? error
      : new ReaderError(
          controller.signal.aborted ? "interrupted" : "local-error",
        );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    try {
      await account?.close();
    } finally {
      ownership?.close();
    }
  }
}
