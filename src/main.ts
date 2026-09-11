import { app, session } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Account } from "./account.js";
import { parseCommand, HELP } from "./cli.js";
import { LIMITS, parseOpen, ReaderError, safeShape } from "./domain.js";
import { PROTOCOL } from "./protocol.js";
import { syncNotebook } from "./snapshots.js";

process.umask(0o077);
const root = join(homedir(), "Library", "Application Support", "Scribe Reader");
app.setPath("userData", root);
app.setPath("sessionData", join(root, "chromium"));
app.setName("Scribe Reader");
app.on("window-all-closed", () => {});
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
function emit(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
async function main() {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(HELP);
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!app.requestSingleInstanceLock()) throw new ReaderError("busy");
  await app.whenReady();
  const ownedSession = session.fromPartition("persist:scribe-reader");
  ownedSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  ownedSession.setPermissionCheckHandler(() => false);
  ownedSession.on("will-download", (event) => event.preventDefault());
  const account = new Account(ownedSession, controller.signal);
  const timer = setTimeout(
    () => controller.abort(),
    command.kind === "login" ? 15 * 60_000 : LIMITS.syncMs,
  );
  try {
    if (command.kind === "login") {
      await account.login();
      await ownedSession.cookies.flushStore();
      emit({ kind: "login-confirmed", evidence: "parsed-notebook-list" });
      return;
    }
    if (command.kind === "list") {
      emit({ kind: "notebooks-listed", notebooks: await account.list() });
      return;
    }
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
        emit({ kind: "probe-metadata-unsupported", directory });
        return;
      }
      if (command.ordinal > opened.metadata.totalPages)
        throw new ReaderError("invalid-page");
      const page = command.ordinal - 1;
      const bytes = await account.render(page, opened.token);
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
      emit(receipt);
      return;
    }
    if (!PROTOCOL.verified) throw new ReaderError("protocol-unverified");
    emit(
      await syncNotebook({
        account,
        root,
        notebookId: command.notebookId,
        full: command.full,
        signal: controller.signal,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}
void main()
  .then(() => app.exit(0))
  .catch((error) => {
    emit({
      kind:
        error instanceof ReaderError
          ? error.kind
          : controller.signal.aborted
            ? "interrupted"
            : "local-error",
    });
    app.exit(1);
  });
