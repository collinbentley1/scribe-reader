import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CERTIFICATE_PATH,
  startFixture,
} from "../test/native-fixture/server.js";

const command = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = await mkdtemp(join(tmpdir(), "scribe-native-shortcuts-"));
const contents = join(out, "Scribe Shortcut Fixture.app", "Contents");
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Resources"));
const source = await readFile(join(root, "native", "main.swift"), "utf8");
const entry = source.lastIndexOf(
  "\nlet args = Array(CommandLine.arguments.dropFirst())",
);
if (entry < 0) throw new Error("native-cli-entry-not-found");
const testSource =
  source.slice(0, entry) +
  "\n" +
  (await readFile(join(root, "test", "native-shortcuts.swift"), "utf8"));
const testPath = join(out, "main.swift");
await writeFile(testPath, testSource);
await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cdbentley.scribe-reader.shortcut-fixture</string><key>CFBundleName</key><string>Scribe Shortcut Fixture</string><key>CFBundleExecutable</key><string>Scribe Shortcut Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
);
await cp(
  join(root, "native", "bridge.js"),
  join(contents, "Resources", "bridge.js"),
);
await writeFile(
  join(contents, "Resources", "fixture.der"),
  new X509Certificate(await readFile(CERTIFICATE_PATH)).raw,
);
const executable = join(contents, "MacOS", "Scribe Shortcut Fixture");
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
    testPath,
    "-o",
    executable,
  ],
  { timeout: 120_000 },
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
  dirname(contents),
]);
const fixture = startFixture();
try {
  const result = await command(executable, [], { cwd: "/", timeout: 25_000 });
  process.stdout.write(result.stdout);
  await writeFile(join(out, "receipt.json"), result.stdout);
} catch (error) {
  if (
    error instanceof Error &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    process.stdout.write(error.stdout);
    await writeFile(join(out, "receipt.json"), error.stdout);
  }
  process.exitCode = 1;
} finally {
  await fixture.stop();
}
process.stdout.write(JSON.stringify({ artifactDirectory: out }) + "\n");
