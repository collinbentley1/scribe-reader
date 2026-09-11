import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Account, FrameReader } from "../src/account.js";
import { LIMITS } from "../src/domain.js";
import { syncNotebook } from "../src/snapshots.js";
import { parseRenderedPage } from "../src/protocol.js";
import { PRODUCT, readerPlist, type ProductBuild } from "../src/product.js";
import {
  startFixture,
  CERTIFICATE_PATH,
} from "../test/native-fixture/server.js";
import {
  SYNTHETIC_NOTEBOOK_ID,
  SYNTHETIC_RENDERING_TOKEN,
} from "../test/native-fixture/responses.js";

const command = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (
  args.length !== 0 &&
  (args.length !== 2 || args[0] !== "--out" || !args[1] || !isAbsolute(args[1]))
)
  throw new Error("invalid-arguments");
const out =
  args[1] ?? (await mkdtemp(join(tmpdir(), "scribe-native-fixture-")));
await mkdir(out, { recursive: true });
const app = join(out, "Scribe Reader Fixture.app"),
  contents = join(app, "Contents"),
  executable = join(contents, "MacOS", PRODUCT.readerName);
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Resources"), { recursive: true });
const release: ProductBuild = {
  schemaVersion: 1,
  productId: PRODUCT.id,
  readerId: PRODUCT.readerId,
  version: "0.1.0",
  build: "1",
  sourceRevision: "0".repeat(40),
  sourceDigest: "0".repeat(64),
  sourceDirty: true,
  bunVersion: PRODUCT.bunVersion,
  transport: PRODUCT.transport,
  swiftVersion: "fixture",
  sdkVersion: "fixture",
};
await writeFile(
  join(contents, "Info.plist"),
  readerPlist(release).replace(PRODUCT.readerId, PRODUCT.readerId + ".fixture"),
);
await cp(
  join(root, "native", "bridge.js"),
  join(contents, "Resources", "bridge.js"),
);
await writeFile(
  join(contents, "Resources", "fixture.der"),
  new X509Certificate(await readFile(CERTIFICATE_PATH)).raw,
);
await command(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-swift-version",
    "6",
    "-warnings-as-errors",
    "-D",
    "SYNTHETIC_FIXTURE",
    "-target",
    "arm64-apple-macosx14.0",
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    join(root, "native", "main.swift"),
    "-o",
    executable,
  ],
  { cwd: "/", timeout: 120_000 },
);
await command("/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--timestamp=none",
  "--entitlements",
  join(root, "packaging", "empty-entitlements.plist"),
  app,
]);
await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
assert.match(
  (await command(executable, ["--help"], { cwd: "/" })).stdout,
  /Scribe Reader Capture/,
);
assert.equal(
  JSON.parse((await command(executable, ["--version"], { cwd: "/" })).stdout)
    .transport,
  PRODUCT.transport,
);
await assert.rejects(command(executable, ["invalid"], { cwd: "/" }));
const fixture = startFixture(),
  checks: string[] = [];
const proof: Record<string, unknown> = {};
function wire(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
function rawSession() {
  const child = spawn(executable, ["--pipe"], {
    cwd: "/",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = new FrameReader(child.stdout);
  const stderr: Buffer[] = [];
  child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  child.stdin.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let id = 0;
  async function request(value: Record<string, unknown>, limit = LIMITS.json) {
    const current = ++id;
    child.stdin.write(wire({ version: 1, id: current, ...value }));
    return frames.response(current, limit);
  }
  async function close() {
    child.stdin.end();
    const result = await exited;
    const metrics = Buffer.concat(stderr)
      .toString("utf8")
      .split("\n")
      .find((line) => line.startsWith("{") && line.includes("fixture-closed"));
    return { ...result, metrics: metrics ? JSON.parse(metrics) : null };
  }
  return { child, frames, exited, request, close };
}
let account: Account | undefined;
try {
  account = await Account.connect(executable, new AbortController().signal);
  assert.equal((await account.list())[0]?.id, SYNTHETIC_NOTEBOOK_ID);
  const opened = await account.open(SYNTHETIC_NOTEBOOK_ID);
  assert.equal(opened.metadata.totalPages, 83);
  const captured = await syncNotebook({
    account,
    root: join(out, "data"),
    notebookId: SYNTHETIC_NOTEBOOK_ID,
    full: true,
    signal: new AbortController().signal,
  });
  assert.equal(captured.kind, "snapshot-published");
  assert.equal(fixture.snapshot().requestCounts.render, 83);
  assert.equal(fixture.snapshot().maxInflight, 1);
  const repeat = await syncNotebook({
    account,
    root: join(out, "data"),
    notebookId: SYNTHETIC_NOTEBOOK_ID,
    full: false,
    signal: new AbortController().signal,
  });
  assert.equal(repeat.kind, "metadata-match");
  assert.equal(fixture.snapshot().requestCounts.render, 83);
  proof.capture = { captured, repeat, transport: fixture.snapshot() };
  checks.push(
    "83 validated pages, metadata brackets, unchanged metadata fast path",
  );
  assert(
    fixture
      .snapshot()
      .observations.filter((entry) => entry.endpoint !== "root")
      .every((entry) => entry.cookie?.includes("fixture_session=synthetic")),
  );
  assert(
    fixture
      .snapshot()
      .observations.filter((entry) => entry.endpoint === "render")
      .every((entry) => entry.renderingToken === SYNTHETIC_RENDERING_TOKEN),
  );
  checks.push("WebKit cookie and rendering header");
  await account.close();
  account = undefined;
  account = await Account.connect(executable, new AbortController().signal);
  assert(
    fixture
      .snapshot()
      .observations.filter((entry) => entry.endpoint === "root")
      .at(-1)
      ?.cookie?.includes("fixture_session=synthetic"),
  );
  checks.push("persistent cookie reused at helper restart");
  await assert.rejects(
    Account.connect(executable, new AbortController().signal),
    /busy/,
  );
  checks.push("exclusive session ownership");
  for (const scenario of [
    "same-origin-redirect",
    "cross-origin-redirect",
  ] as const) {
    fixture.setScenario(scenario);
    await assert.rejects(account.list(), /network-error/);
    assert(
      !fixture
        .snapshot()
        .observations.some((entry) => entry.query.fixtureRedirected === "1"),
    );
  }
  checks.push("same-origin and cross-origin API redirects rejected");
  fixture.setScenario("json-2mib-exact");
  await account.list();
  await account.open(SYNTHETIC_NOTEBOOK_ID);
  fixture.setScenario("json-2mib-over");
  await assert.rejects(account.list(), /response-too-large/);
  fixture.setScenario("render-64mib-exact");
  assert.equal(
    (await account.render(0, SYNTHETIC_RENDERING_TOKEN)).length,
    LIMITS.archive,
  );
  fixture.setScenario("render-64mib-over");
  await assert.rejects(
    account.render(0, SYNTHETIC_RENDERING_TOKEN),
    /response-too-large/,
  );
  checks.push("2 MiB JSON and 64 MiB archive exact and excess limits");
  await account.close();
  account = undefined;
  fixture.setScenario("slow-cancellation");
  const controller = new AbortController();
  account = await Account.connect(executable, controller.signal);
  const pending = account.render(0, SYNTHETIC_RENDERING_TOKEN);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, /interrupted/);
  await account.close();
  account = undefined;
  fixture.setScenario("normal");
  account = await Account.connect(executable, new AbortController().signal);
  await account.list();
  await account.close();
  account = undefined;
  checks.push("transfer cancellation tears down child and releases lock");
  for (const value of [
    { version: true, id: 1, kind: "connect", login: false },
    { version: 1, id: true, kind: "connect", login: false },
    { version: 1, id: 1, kind: "connect", login: 1 },
    {
      version: 1,
      id: 1,
      kind: "render",
      page: false,
      token: SYNTHETIC_RENDERING_TOKEN,
    },
    {
      version: 1,
      id: 1,
      kind: "render",
      page: 0.5,
      token: SYNTHETIC_RENDERING_TOKEN,
    },
    { version: 1, id: 1, kind: "notes", url: "https://example.invalid" },
  ]) {
    const raw = rawSession();
    raw.child.stdin.end(wire(value));
    assert.equal((await raw.exited).code, 1);
  }
  for (const bytes of [
    Buffer.from([0, 1, 0, 1]),
    Buffer.from([0, 0, 0, 5, 123]),
    Buffer.from([0, 0]),
  ]) {
    const raw = rawSession();
    raw.child.stdin.end(bytes);
    assert.equal((await raw.exited).code, 1);
  }
  checks.push(
    "native control shape, strict JSON types, oversize and truncated frames",
  );
  const overlap = rawSession();
  overlap.child.stdin.write(
    Buffer.concat([
      wire({ version: 1, id: 1, kind: "connect", login: false }),
      wire({ version: 1, id: 2, kind: "notes" }),
    ]),
  );
  assert.equal((await overlap.exited).code, 1);
  checks.push("overlapping requests refused");
  const raw = rawSession();
  await raw.request({ kind: "connect", login: false }, 0);
  const pid = raw.child.pid;
  for (let page = 0; page < 83; page++) {
    const archive = await raw.request(
      { kind: "render", page, token: SYNTHETIC_RENDERING_TOKEN },
      LIMITS.archive,
    );
    parseRenderedPage(archive, { notebookId: SYNTHETIC_NOTEBOOK_ID, page });
    assert.equal(raw.child.pid, pid);
    assert.equal(raw.child.exitCode, null);
  }
  fixture.setScenario("render-64mib-exact");
  assert.equal(
    (
      await raw.request(
        { kind: "render", page: 0, token: SYNTHETIC_RENDERING_TOKEN },
        LIMITS.archive,
      )
    ).length,
    LIMITS.archive,
  );
  const closed = await raw.close();
  assert.equal(closed.code, 0);
  assert.equal(closed.metrics.pid, pid);
  assert.equal(closed.metrics.peakPendingChunks, 1);
  assert.equal(closed.metrics.peakBodyBytes, LIMITS.archive);
  assert(closed.metrics.acceptedChunks >= 83);
  proof.nativeMetrics = closed.metrics;
  checks.push(
    "83 renders in one native PID and one acknowledged chunk outstanding",
  );
  fixture.setScenario("slow-cancellation");
  for (const mode of ["eof", "SIGTERM", "SIGKILL"] as const) {
    const session = rawSession();
    await session.request({ kind: "connect", login: false }, 0);
    const response = session.request(
      { kind: "render", page: 0, token: SYNTHETIC_RENDERING_TOKEN },
      LIMITS.archive,
    );
    const rejected = assert.rejects(response, /native-transport-closed/);
    await Bun.sleep(100);
    const started = Date.now();
    if (mode === "eof") session.child.stdin.end();
    else session.child.kill(mode);
    await session.exited;
    await rejected;
    assert(Date.now() - started < 3000);
    account = await Account.connect(executable, new AbortController().signal);
    await account.close();
    account = undefined;
  }
  checks.push(
    "EOF, SIGTERM and SIGKILL terminate transfer and release native ownership",
  );
  const receipt = {
    kind: "native-fixture-passed",
    app,
    checks,
    accountAccess: false,
    productionStoreAccess: false,
    proof,
    fixture: fixture.snapshot(),
  };
  await writeFile(
    join(out, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({ kind: receipt.kind, out, checks }) + "\n",
  );
} finally {
  await account?.close();
  await fixture.stop();
}
