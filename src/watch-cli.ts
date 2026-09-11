import { ReaderError } from "./domain.js";
import {
  acknowledge,
  checkOnce,
  manualEvent,
  ownerStatus,
  readState,
  readWatchConfig,
  recover,
  runWatcher,
  target,
  withLock,
} from "./watch.js";
import { serviceCommand } from "./watch-service.js";
import { join } from "node:path";

const HELP = `Scribe Reader watcher

  run|check|status --config /absolute/integration.json
  install|start|stop|remove --config /absolute/integration.json
  recover --config /absolute/integration.json [--retry-uncertain]
  target --config /absolute/integration.json
  acknowledge --config /absolute/integration.json --receipt /absolute/receipt.json
  delivery-test|bootstrap --config /absolute/integration.json

For login, use stop, the existing reader login command, recover, then start.
Delivery-test explicitly queues one transport test without notebook preparation.
Bootstrap explicitly queues review when no reviewed baseline exists.
Recovery never retries an accepted queued message. Retrying an uncertain attempt may duplicate delivery.
`;

type WatchCommand =
  | {
      kind:
        | "run"
        | "check"
        | "status"
        | "install"
        | "start"
        | "stop"
        | "remove"
        | "target"
        | "delivery-test"
        | "bootstrap";
      configPath: string;
    }
  | { kind: "recover"; configPath: string; retryUncertain: boolean }
  | { kind: "acknowledge"; configPath: string; receiptPath: string }
  | { kind: "help" };

export function parseWatchCommand(args: string[]): WatchCommand {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help"))
    return { kind: "help" };
  const [kind, flag, configPath, ...rest] = args;
  if (flag !== "--config" || !configPath)
    throw new ReaderError("invalid-arguments");
  if (
    kind === "acknowledge" &&
    rest.length === 2 &&
    rest[0] === "--receipt" &&
    rest[1]
  )
    return { kind, configPath, receiptPath: rest[1] };
  if (
    kind === "recover" &&
    (rest.length === 0 ||
      (rest.length === 1 && rest[0] === "--retry-uncertain"))
  )
    return { kind, configPath, retryUncertain: rest.length === 1 };
  if (
    rest.length === 0 &&
    (kind === "run" ||
      kind === "check" ||
      kind === "status" ||
      kind === "install" ||
      kind === "start" ||
      kind === "stop" ||
      kind === "remove" ||
      kind === "target" ||
      kind === "delivery-test" ||
      kind === "bootstrap")
  )
    return { kind, configPath };
  throw new ReaderError("invalid-arguments");
}

async function main(): Promise<void> {
  process.umask(0o077);
  const command = parseWatchCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(HELP);
    return;
  }
  const config = await readWatchConfig(command.configPath),
    controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const emit = (value: unknown) =>
    process.stdout.write(JSON.stringify(value) + "\n");
  switch (command.kind) {
    case "run":
      await runWatcher(config, controller.signal);
      return;
    case "check":
      emit(
        await withLock(join(config.watchRoot, "supervisor.lock"), () =>
          checkOnce(config, controller.signal),
        ),
      );
      return;
    case "status":
      emit({
        owner: await ownerStatus(config),
        state: await readState(config),
      });
      return;
    case "target":
      emit(await target(config));
      return;
    case "acknowledge":
      emit(await acknowledge(config, command.receiptPath, controller.signal));
      return;
    case "recover":
      emit(await recover(config, command.retryUncertain));
      return;
    case "delivery-test":
    case "bootstrap":
      emit(await manualEvent(config, command.kind, controller.signal));
      return;
    case "install":
    case "start":
    case "stop":
    case "remove":
      emit(
        await serviceCommand({
          config,
          command: command.kind,
          signal: controller.signal,
        }),
      );
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(String(exhaustive));
    }
  }
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        kind: error instanceof ReaderError ? error.kind : "local-error",
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
