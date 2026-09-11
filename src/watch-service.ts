import {
  access,
  lstat,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReaderError } from "./domain.js";
import {
  boundedRead,
  durableFile,
  isMissing,
  ownerStatus,
  runProcess,
  withLock,
  type WatchConfig,
  type Execute,
} from "./watch.js";
import { PRODUCT } from "./product.js";

export const SERVICE_LABEL = "com.scribe-reader.watch";
function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export function launchAgent(config: WatchConfig): string {
  const args = [config.product.watcher, "run", "--config", config.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>AssociatedBundleIdentifiers</key><array><string>${PRODUCT.id}</string></array>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>/</string>
<key>EnvironmentVariables</key><dict><key>BUN_OPTIONS</key><string></string><key>BUN_BE_BUN</key><string>0</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>20</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(config.watchRoot, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(config.watchRoot, "service-error.log"))}</string>
</dict></plist>
`;
}
async function dependencies(
  config: WatchConfig,
  signal: AbortSignal,
  execute: Execute,
): Promise<void> {
  await access(config.product.reader, constants.X_OK);
  await access(config.product.watcher, constants.X_OK);
  await access(config.codexExecutable, constants.X_OK);
  const codex = await execute(config.codexExecutable, ["queue", "--help"], {
    cwd: config.workspace,
    timeoutMs: 10_000,
    signal,
  });
  if (
    codex.kind !== "completed" ||
    codex.code !== 0 ||
    !codex.stdout.includes("--thread") ||
    !codex.stdout.includes("--message")
  )
    throw new ReaderError("codex-queue-required");
  if (Bun.version !== PRODUCT.bunVersion)
    throw new ReaderError("bun-version-required");
  const python = await execute(
    config.pythonExecutable,
    [
      "-B",
      "-c",
      "import sys, reportlab; assert sys.version_info >= (3, 10); assert reportlab.Version == '4.4.9'",
    ],
    { cwd: config.workspace, timeoutMs: 5000, signal },
  );
  if (python.kind !== "completed" || python.code !== 0)
    throw new ReaderError("python-reportlab-required");
  const signed = await execute(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", config.product.app],
    {
      cwd: "/",
      timeoutMs: 15_000,
      signal,
    },
  );
  if (signed.kind !== "completed" || signed.code !== 0)
    throw new ReaderError("product-signature-required");
}
async function installSkill(config: WatchConfig): Promise<void> {
  const installed = dirname(config.skillPath),
    source = config.product.skill;
  await access(join(source, "SKILL.md"), constants.R_OK);
  try {
    const info = await lstat(installed);
    if (!info.isSymbolicLink() || (await readlink(installed)) !== source)
      throw new ReaderError("skill-install-conflict-backup-existing-directory");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(dirname(installed), { recursive: true, mode: 0o700 });
    await symlink(source, installed);
  }
}
export async function serviceCommand({
  config,
  command,
  signal,
  execute = runProcess,
  signalProcess = process.kill,
  launchAgentDirectory = join(homedir(), "Library", "LaunchAgents"),
}: {
  config: WatchConfig;
  command: "install" | "start" | "stop" | "remove";
  signal: AbortSignal;
  execute?: Execute;
  signalProcess?: typeof process.kill;
  launchAgentDirectory?: string;
}): Promise<unknown> {
  if (process.platform !== "darwin" || process.getuid === undefined)
    throw new ReaderError("macos-user-service-required");
  const domain = `gui/${process.getuid()}`,
    target = `${domain}/${SERVICE_LABEL}`;
  const plist = join(launchAgentDirectory, SERVICE_LABEL + ".plist");
  async function inspectOwner() {
    const owner = await ownerStatus(config, execute, signalProcess);
    if (owner.kind === "unknown") throw new ReaderError("watch-owner-unknown");
    return owner;
  }
  let installed = false;
  try {
    if ((await boundedRead(plist)).toString("utf8") !== launchAgent(config))
      throw new ReaderError("service-config-mismatch");
    installed = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  async function presence(): Promise<"loaded" | "absent" | "unknown"> {
    const result = await execute("/bin/launchctl", ["print", target], {
      cwd: "/",
      timeoutMs: 5000,
      signal,
    });
    if (result.kind !== "completed") return "unknown";
    return result.code === 0
      ? "loaded"
      : result.code === 113
        ? "absent"
        : "unknown";
  }
  if (command === "stop" || command === "remove") {
    const before = await inspectOwner();
    if (installed)
      await execute("/bin/launchctl", ["bootout", target], {
        cwd: config.workspace,
        timeoutMs: 30_000,
        signal,
      });
    const unloadDeadline = Date.now() + 30_000;
    for (;;) {
      const current = await presence();
      if (current === "absent") break;
      if (current === "unknown" || !installed || Date.now() >= unloadDeadline)
        throw new ReaderError("service-stop-unconfirmed");
      await delay(100, undefined, { signal });
    }
    const owner = await inspectOwner();
    if (owner.kind === "running") {
      if (
        before.kind !== "running" ||
        before.pid !== owner.pid ||
        before.started !== owner.started
      )
        throw new ReaderError("watch-owner-changed");
      const verified = await inspectOwner();
      if (verified.kind === "running") {
        if (verified.pid !== owner.pid || verified.started !== owner.started)
          throw new ReaderError("watch-owner-changed");
        try {
          signalProcess(verified.pid, "SIGTERM");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = await inspectOwner();
      if (current.kind === "stopped") break;
      if (
        owner.kind !== "running" ||
        current.pid !== owner.pid ||
        current.started !== owner.started
      )
        throw new ReaderError("watch-owner-changed");
      if (Date.now() > deadline) throw new ReaderError("watch-stop-incomplete");
      await delay(100, undefined, { signal });
    }
    await withLock(join(config.watchRoot, "supervisor.lock"), async () => {
      if (command === "remove") await rm(plist, { force: true });
    });
    return {
      kind: command === "remove" ? "service-removed" : "service-stopped",
    };
  }
  if (!installed) {
    const current = await presence();
    if (current !== "absent")
      throw new ReaderError("service-unbound-registration");
    if (command === "start") throw new ReaderError("service-not-installed");
  }
  await dependencies(config, signal, execute);
  if (command === "install") {
    const installedApp = await realpath(
      join(
        dirname(dirname(launchAgentDirectory)),
        "Applications",
        PRODUCT.name + ".app",
      ),
    ).catch(() => null);
    if (config.product.app !== installedApp)
      throw new ReaderError("installed-product-location-required");
    const owner = await inspectOwner();
    if (installed && owner.kind === "running") {
      if ((await readlink(dirname(config.skillPath))) !== config.product.skill)
        throw new ReaderError(
          "skill-install-conflict-backup-existing-directory",
        );
    } else {
      await withLock(join(config.watchRoot, "supervisor.lock"), async () => {
        await installSkill(config);
        if (!installed) await durableFile(plist, launchAgent(config));
      });
    }
  }
  if ((await boundedRead(plist)).toString("utf8") !== launchAgent(config))
    throw new ReaderError("service-config-mismatch");
  const loaded = await presence();
  if (loaded === "unknown") throw new ReaderError("service-status-unknown");
  if (loaded === "absent") {
    await inspectOwner();
    const result = await execute(
      "/bin/launchctl",
      ["bootstrap", domain, plist],
      { cwd: config.workspace, timeoutMs: 15_000, signal },
    );
    if (result.kind !== "completed" || result.code !== 0)
      throw new ReaderError("service-start-failed");
  } else if ((await inspectOwner()).kind !== "running") {
    const result = await execute("/bin/launchctl", ["kickstart", target], {
      cwd: config.workspace,
      timeoutMs: 15_000,
      signal,
    });
    if (result.kind !== "completed" || result.code !== 0)
      throw new ReaderError("service-start-failed");
  }
  const deadline = Date.now() + 10_000;
  while ((await inspectOwner()).kind !== "running") {
    if (Date.now() > deadline)
      throw new ReaderError("service-owner-not-observed");
    await delay(100, undefined, { signal });
  }
  return { kind: "service-running", owner: await inspectOwner(), plist };
}
