import { ReaderError, string } from "./domain.js";
export type Command =
  | { kind: "help" }
  | { kind: "login" }
  | { kind: "list" }
  | { kind: "probe"; notebookId: string; ordinal: number }
  | { kind: "sync"; notebookId: string; full: boolean };
export function parseCommand(args: string[]): Command {
  const [kind, id, ...rest] = args;
  if ((kind === undefined || kind === "--help") && args.length <= 1)
    return { kind: "help" };
  if ((kind === "login" || kind === "list") && args.length === 1)
    return { kind };
  if (
    kind === "probe" &&
    id &&
    (rest.length === 0 || (rest.length === 2 && rest[0] === "--page"))
  ) {
    const ordinal = rest.length ? Number(rest[1]) : 1;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1000)
      throw new ReaderError("invalid-arguments");
    return { kind, notebookId: string(id), ordinal };
  }
  if (
    kind === "sync" &&
    id &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === "--full"))
  )
    return { kind, notebookId: string(id), full: rest.length === 1 };
  throw new ReaderError("invalid-arguments");
}
export const HELP =
  "Scribe Reader\n\n  login\n  list\n  probe NOTEBOOK_ID [--page ORDINAL]\n  sync NOTEBOOK_ID [--full]\n\nProbe uses an unverified zero-based single-page range hypothesis.\n";
