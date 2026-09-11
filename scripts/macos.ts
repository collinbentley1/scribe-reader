import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { integer, record, string } from "../src/domain.js";
import {
  PRODUCT,
  parseProductBuild,
  productPlist,
  readerPlist,
  readProduct,
  type Product,
} from "../src/product.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Scribe Reader macOS packaging

  build --out /absolute/empty/output
  sign --app "/absolute/Scribe Reader.app" --mode adhoc
  sign --app "/absolute/Scribe Reader.app" --mode developer-id --identity IDENTITY --team TEAM
  verify --app "/absolute/Scribe Reader.app" --mode adhoc
  verify --app "/absolute/Scribe Reader.app" --mode developer-id --team TEAM

Build, sign and verify never install or register a service.
Developer ID signing requires an existing authorized keychain identity.
`;

type Signing = { kind: "adhoc" } | { kind: "developer-id"; team: string };
type Command =
  | { kind: "help" }
  | { kind: "build"; out: string }
  | { kind: "sign"; app: string; signing: Signing; identity: string }
  | { kind: "verify"; app: string; signing: Signing };

function absolute(value: string | undefined): string {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("absolute-path-required");
  return resolve(value);
}

export function parseMacCommand(args: string[]): Command {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help"))
    return { kind: "help" };
  const [kind, ...rest] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (!key?.startsWith("--") || !value || flags.has(key))
      throw new Error("invalid-arguments");
    flags.set(key, value);
  }
  if (kind === "build" && [...flags.keys()].every((key) => key === "--out")) {
    return {
      kind,
      out: absolute(flags.get("--out")),
    };
  }
  if (kind !== "sign" && kind !== "verify")
    throw new Error("invalid-arguments");
  const app = absolute(flags.get("--app")),
    mode = flags.get("--mode");
  const allowed =
    kind === "sign"
      ? ["--app", "--mode", "--team", "--identity"]
      : ["--app", "--mode", "--team"];
  if (![...flags.keys()].every((key) => allowed.includes(key)))
    throw new Error("invalid-arguments");
  let signing: Signing;
  if (mode === "adhoc" && !flags.has("--team") && !flags.has("--identity"))
    signing = { kind: "adhoc" };
  else if (
    mode === "developer-id" &&
    /^[A-Z0-9]{10}$/.test(flags.get("--team") ?? "")
  )
    signing = { kind: "developer-id", team: string(flags.get("--team")) };
  else throw new Error("invalid-signing-mode");
  if (kind === "verify") return { kind, app, signing };
  const identity =
    signing.kind === "adhoc" ? "-" : string(flags.get("--identity"));
  if (
    signing.kind === "developer-id" &&
    (identity === "-" || /[\x00-\x1f\x7f]/.test(identity))
  )
    throw new Error("developer-id-identity-required");
  return { kind, app, signing, identity };
}

async function command(
  file: string,
  args: string[],
  cwd = ROOT,
): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of ["BUN_OPTIONS", "BUN_BE_BUN", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  return new Promise((resolveResult, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${basename(file)} failed: ${stderr.trim() || error.message}`,
            ),
          );
        else resolveResult({ stdout, stderr });
      },
    );
  });
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

type Entry = { path: string; mode: number } & (
  { kind: "file"; sha256: string } | { kind: "symlink"; target: string }
);
async function manifest(root: string, paths = [""]): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path),
      name = relative(root, path);
    if (info.isSymbolicLink())
      entries.push({
        path: name,
        mode: info.mode & 0o777,
        kind: "symlink",
        target: await readlink(path),
      });
    else if (info.isDirectory())
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child));
    else if (info.isFile())
      entries.push({
        path: name,
        mode: info.mode & 0o777,
        kind: "file",
        sha256: await fileHash(path),
      });
    else throw new Error("unsupported-package-file");
  }
  for (const path of paths) await visit(join(root, path));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function save(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode });
}

async function copySkill(destination: string): Promise<void> {
  const skill = join(ROOT, "skills", "scribe-prep");
  await mkdir(destination, { recursive: true });
  for (const name of ["SKILL.md", "requirements.txt"])
    await cp(join(skill, name), join(destination, name));
  for (const [directory, extension] of [
    ["scripts", ".py"],
    ["tests", ".py"],
    ["references", ".md"],
  ]) {
    if (!directory || !extension) throw new Error("invalid-skill-layout");
    await mkdir(join(destination, directory));
    for (const entry of await readdir(join(skill, directory), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(extension))
        await cp(
          join(skill, directory, entry.name),
          join(destination, directory, entry.name),
        );
      else if (entry.name !== "__pycache__")
        throw new Error(`unexpected-skill-resource:${entry.name}`);
    }
  }
}

async function build(out: string): Promise<void> {
  if (
    Bun.version !== PRODUCT.bunVersion ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  )
    throw new Error("bun-1.4.2-macos-arm64-required");
  if (await Bun.file(join(out, "build-receipt.json")).exists())
    throw new Error("build-output-already-exists");
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length)
    throw new Error("empty-build-output-required");
  const pkg = record(await json(join(ROOT, "package.json")));
  const inputPaths = [
    "src",
    "native",
    "scripts",
    "packaging",
    "skills/scribe-prep",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "LICENSE",
    "node_modules/pngjs",
  ];
  const inputs = (await manifest(ROOT, inputPaths)).filter(
    (entry) =>
      !entry.path.includes("/__pycache__/") && !entry.path.endsWith(".pyc"),
  );
  const embeddedBunSha256 = await fileHash(process.execPath);
  const sourceRevision = (
    await command("/usr/bin/git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  const sourceDirty =
    (await command("/usr/bin/git", ["status", "--porcelain"])).stdout.trim()
      .length > 0;
  const release = parseProductBuild({
    schemaVersion: 1,
    productId: PRODUCT.id,
    readerId: PRODUCT.readerId,
    version: pkg.version,
    build: String(integer(pkg.macosBuild, 1, 999999)),
    sourceRevision,
    sourceDigest: digest(JSON.stringify(inputs)),
    sourceDirty,
    bunVersion: PRODUCT.bunVersion,
    transport: PRODUCT.transport,
    swiftVersion: (
      await command("/usr/bin/xcrun", ["swiftc", "--version"])
    ).stdout.trim(),
    sdkVersion: (
      await command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"])
    ).stdout.trim(),
  });
  const app = join(out, PRODUCT.name + ".app"),
    contents = join(app, "Contents"),
    capture = join(
      contents,
      "Helpers",
      PRODUCT.readerName + ".app",
      "Contents",
    );
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"));
  await mkdir(join(capture, "MacOS"), { recursive: true });
  await mkdir(join(capture, "Resources"));
  await command("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "6",
    "-warnings-as-errors",
    "-O",
    "-whole-module-optimization",
    "-target",
    "arm64-apple-macosx14.0",
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "native/main.swift",
    "-o",
    join(capture, "MacOS", PRODUCT.readerName),
  ]);
  await writeFile(join(capture, "Info.plist"), readerPlist(release));
  await cp(
    join(ROOT, "native", "bridge.js"),
    join(capture, "Resources", "bridge.js"),
  );
  await command(process.execPath, [
    "build",
    "src/watch-cli.ts",
    "--compile",
    "--target=bun-darwin-arm64",
    `--compile-executable-path=${process.execPath}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "--env=disable",
    `--outfile=${join(contents, "MacOS", PRODUCT.name)}`,
  ]);
  await chmod(join(contents, "MacOS", PRODUCT.name), 0o755);
  await writeFile(join(contents, "Info.plist"), productPlist(release));
  await save(join(contents, "Resources", "build.json"), release, 0o644);
  await copySkill(join(contents, "Resources", "skills", "scribe-prep"));
  await cp(join(ROOT, "LICENSE"), join(contents, "Resources", "LICENSE"));
  await cp(
    join(ROOT, "packaging", "bun-LICENSE.md"),
    join(contents, "Resources", "Bun-LICENSE.md"),
  );
  await cp(
    join(ROOT, "node_modules", "pngjs", "LICENSE"),
    join(contents, "Resources", "pngjs-LICENSE"),
  );
  const finalInputs = (await manifest(ROOT, inputPaths)).filter(
    (entry) =>
      !entry.path.includes("/__pycache__/") && !entry.path.endsWith(".pyc"),
  );
  if (
    JSON.stringify(inputs) !== JSON.stringify(finalInputs) ||
    embeddedBunSha256 !== (await fileHash(process.execPath))
  )
    throw new Error("build-input-changed");
  const product = await readProduct(app),
    outputs = await manifest(app);
  await save(join(out, "build-receipt.json"), {
    kind: "product-built",
    product: product.release,
    inputs,
    embeddedBunSha256,
    outputs,
    manifestSha256: digest(JSON.stringify(outputs)),
  });
  process.stdout.write(
    JSON.stringify({
      kind: "product-built",
      app,
      manifestSha256: digest(JSON.stringify(outputs)),
    }) + "\n",
  );
}

function readerApp(product: Product): string {
  return join(product.app, "Contents", "Helpers", PRODUCT.readerName + ".app");
}

async function signApp(
  app: string,
  signing: Signing,
  identity: string,
): Promise<void> {
  const product = await readProduct(app),
    capture = readerApp(product),
    before = await manifest(product.app);
  await command("/usr/bin/codesign", [
    "--force",
    "--options",
    "runtime",
    signing.kind === "adhoc" ? "--timestamp=none" : "--timestamp",
    "--entitlements",
    join(ROOT, "packaging", "empty-entitlements.plist"),
    "--identifier",
    PRODUCT.readerId,
    "--sign",
    identity,
    capture,
  ]);
  await command("/usr/bin/codesign", [
    "--force",
    "--options",
    "runtime",
    signing.kind === "adhoc" ? "--timestamp=none" : "--timestamp",
    "--entitlements",
    join(ROOT, "packaging", "bun-entitlements.plist"),
    "--identifier",
    PRODUCT.id,
    "--sign",
    identity,
    product.app,
  ]);
  const outputs = await manifest(product.app);
  await save(join(dirname(product.app), `sign-${signing.kind}.json`), {
    kind: "product-signed",
    signing,
    identity,
    beforeManifestSha256: digest(JSON.stringify(before)),
    manifestSha256: digest(JSON.stringify(outputs)),
    outputs,
  });
  process.stdout.write(
    JSON.stringify({
      kind: "product-signed",
      app: product.app,
      mode: signing.kind,
      manifestSha256: digest(JSON.stringify(outputs)),
    }) + "\n",
  );
}

async function codePaths(app: string): Promise<string[]> {
  const paths = [app];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name),
        info = await lstat(child);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (name.endsWith(".app") || name.endsWith(".framework"))
          paths.push(child);
        await visit(child);
      } else if (info.isFile() && info.size >= 4) {
        const handle = await open(child, "r");
        try {
          const header = Buffer.alloc(4);
          await handle.read(header, 0, 4, 0);
          if (
            [
              "feedface",
              "cefaedfe",
              "feedfacf",
              "cffaedfe",
              "cafebabe",
              "bebafeca",
              "cafebabf",
              "bfbafeca",
            ].includes(header.toString("hex"))
          )
            paths.push(child);
        } finally {
          await handle.close();
        }
      }
    }
  }
  await visit(join(app, "Contents"));
  return paths;
}

async function plist(path: string): Promise<Record<string, unknown>> {
  return record(
    JSON.parse(
      (await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]))
        .stdout,
    ) as unknown,
  );
}

async function verify(app: string, signing: Signing): Promise<void> {
  const product = await readProduct(app),
    capture = readerApp(product);
  await command("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    product.app,
  ]);
  const helperInfo = await plist(join(capture, "Contents", "Info.plist"));
  if (
    helperInfo.CFBundleIdentifier !== PRODUCT.readerId ||
    helperInfo.CFBundleExecutable !== PRODUCT.readerName
  )
    throw new Error("reader-bundle-identity-mismatch");
  const scratch = await mkdtemp(join(tmpdir(), "scribe-signature-")),
    signatures: unknown[] = [];
  try {
    const paths = await codePaths(product.app);
    const expectedPaths = new Set([
      product.app,
      product.watcher,
      capture,
      product.reader,
    ]);
    if (
      paths.length !== expectedPaths.size ||
      paths.some((path) => !expectedPaths.has(path))
    )
      throw new Error("unexpected-bundled-code");
    for (const path of paths) {
      const display = (
        await command("/usr/bin/codesign", ["--display", "--verbose=4", path])
      ).stderr;
      const field = (prefix: string) =>
        display
          .split("\n")
          .find((line) => line.startsWith(prefix))
          ?.slice(prefix.length);
      const identifier = field("Identifier="),
        team = field("TeamIdentifier="),
        timestamp = field("Timestamp="),
        authorities = display
          .split("\n")
          .filter((line) => line.startsWith("Authority="))
          .map((line) => line.slice("Authority=".length));
      const flags = Number.parseInt(
        display.match(/flags=0x([a-f0-9]+)/i)?.[1] ?? "0",
        16,
      );
      if ((flags & 0x10000) === 0)
        throw new Error(
          `hardened-runtime-missing:${relative(product.app, path)}`,
        );
      if (signing.kind === "adhoc") {
        if (
          field("Signature=") !== "adhoc" ||
          (team && team !== "not set") ||
          authorities.length ||
          timestamp
        )
          throw new Error("ad-hoc-signature-mismatch");
      } else if (
        team !== signing.team ||
        !authorities.some((authority) =>
          authority.startsWith("Developer ID Application:"),
        ) ||
        !timestamp
      )
        throw new Error("developer-id-signature-mismatch");
      if (
        (path === product.app || path === product.watcher) &&
        identifier !== PRODUCT.id
      )
        throw new Error("watcher-signature-identity-mismatch");
      if (
        (path === capture || path === product.reader) &&
        identifier !== PRODUCT.readerId
      )
        throw new Error("reader-signature-identity-mismatch");
      const expected =
        path === product.app || path === product.watcher
          ? "bun-entitlements.plist"
          : "empty-entitlements.plist";
      const entitlements = (
        await command("/usr/bin/codesign", [
          "--display",
          "--entitlements",
          ":-",
          path,
        ])
      ).stdout.trim();
      const actualPath = join(scratch, "entitlements.plist");
      await writeFile(
        actualPath,
        entitlements || '<plist version="1.0"><dict/></plist>',
      );
      const actual = await plist(actualPath),
        wanted = await plist(join(ROOT, "packaging", expected));
      const ordered = (value: Record<string, unknown>) =>
        JSON.stringify(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        );
      if (ordered(actual) !== ordered(wanted))
        throw new Error(`entitlements-mismatch:${relative(product.app, path)}`);
      signatures.push({
        path: relative(product.app, path) || ".",
        identifier,
        team: team ?? null,
        authorities,
        timestamp: timestamp ?? null,
        entitlements: actual,
        hardenedRuntime: true,
      });
    }
    const outputs = await manifest(product.app);
    for (const entry of outputs) {
      if (entry.path.includes("/__pycache__/") || entry.path.endsWith(".pyc"))
        throw new Error("python-cache-in-product");
      if (
        entry.kind === "symlink" &&
        !(await realpath(join(product.app, entry.path))).startsWith(
          product.app + "/",
        )
      )
        throw new Error("product-symlink-outside-bundle");
    }
    const receipt = {
      kind: "product-verified",
      mode: signing.kind,
      product: product.release,
      signatures,
      manifestSha256: digest(JSON.stringify(outputs)),
      gatekeeperAssessed: false,
      notarizationVerified: false,
    };
    await save(
      join(dirname(product.app), `verify-${signing.kind}.json`),
      receipt,
    );
    process.stdout.write(
      JSON.stringify({
        kind: receipt.kind,
        app: product.app,
        mode: signing.kind,
        signedObjects: signatures.length,
        manifestSha256: receipt.manifestSha256,
      }) + "\n",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const parsed = parseMacCommand(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (process.platform !== "darwin") throw new Error("macos-required");
  switch (parsed.kind) {
    case "build":
      await build(parsed.out);
      return;
    case "sign":
      await signApp(parsed.app, parsed.signing, parsed.identity);
      return;
    case "verify":
      await verify(parsed.app, parsed.signing);
      return;
    default: {
      const exhaustive: never = parsed;
      throw new Error(String(exhaustive));
    }
  }
}

if (import.meta.main)
  void main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        kind: "packaging-failed",
        message: error instanceof Error ? error.message : String(error),
      }) + "\n",
    );
    process.exitCode = 1;
  });
