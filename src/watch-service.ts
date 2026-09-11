import { access, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReaderError } from "./domain.js";
import {
  boundedRead,
  durableFile,
  electronExecutable,
  isMissing,
  ownerStatus,
  runProcess,
  withLock,
  type WatchConfig,
  type Execute,
} from "./watch.js";

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
  const args = [
    config.bunExecutable,
    "--no-env-file",
    join(config.sourceDirectory, "dist", "watch.js"),
    "run",
    "--config",
    config.configPath,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(config.workspace)}</string>
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
  await electronExecutable(config);
  await access(config.codexExecutable, constants.X_OK);
  await access(
    join(config.sourceDirectory, "dist", "watch.js"),
    constants.R_OK,
  );
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
  const bun = await execute(config.bunExecutable, ["--version"], {
    cwd: config.workspace,
    timeoutMs: 5000,
    signal,
  });
  if (
    bun.kind !== "completed" ||
    bun.code !== 0 ||
    bun.stdout.trim() !== "1.4.2"
  )
    throw new ReaderError("bun-version-required");
  const python = await execute(
    config.pythonExecutable,
    [
      "-c",
      "import sys, reportlab; assert sys.version_info >= (3, 10); assert reportlab.Version == '4.4.9'",
    ],
    { cwd: config.workspace, timeoutMs: 5000, signal },
  );
  if (python.kind !== "completed" || python.code !== 0)
    throw new ReaderError("python-reportlab-required");
}
async function installSkill(config: WatchConfig): Promise<void> {
  const installed = dirname(config.skillPath),
    source = join(config.sourceDirectory, "skills", "scribe-prep");
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
  if (command === "stop" || command === "remove") {
    const before = await inspectOwner();
    if (installed)
      await execute("/bin/launchctl", ["bootout", target], {
        cwd: config.workspace,
        timeoutMs: 30_000,
        signal,
      });
    const unloaded = await execute("/bin/launchctl", ["print", target], {
      cwd: config.workspace,
      timeoutMs: 5000,
      signal,
    });
    if (unloaded.kind !== "completed" || unloaded.code !== 113)
      throw new ReaderError("service-stop-unconfirmed");
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
  await dependencies(config, signal, execute);
  if (command === "install") {
    if (
      config.sourceDirectory.includes("/.worktrees/") ||
      config.sourceDirectory.startsWith("/tmp/")
    )
      throw new ReaderError("stable-source-directory-required");
    const owner = await inspectOwner();
    if (installed && owner.kind === "running") {
      if (
        (await readlink(dirname(config.skillPath))) !==
        join(config.sourceDirectory, "skills", "scribe-prep")
      )
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
  const loaded = await execute("/bin/launchctl", ["print", target], {
    cwd: config.workspace,
    timeoutMs: 5000,
    signal,
  });
  if (loaded.kind !== "completed" || (loaded.code !== 0 && loaded.code !== 113))
    throw new ReaderError("service-status-unknown");
  if (loaded.code === 113) {
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
