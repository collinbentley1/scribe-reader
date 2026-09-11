import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import {
  LIMITS,
  parseNotes,
  parseOpen,
  ReaderError,
  record,
  integer,
} from "./domain.js";

const CONTROL_LIMIT = 65_536;
type Request =
  | { kind: "connect"; login: boolean }
  | { kind: "notes" }
  | { kind: "open"; notebookId: string }
  | { kind: "render"; page: number; token: string };
const NATIVE_ERRORS = new Set([
  "protocol-unsupported",
  "authentication-required",
  "network-error",
  "service-error",
  "response-too-large",
  "request-timeout",
  "interrupted",
  "busy",
  "login-cancelled",
  "local-error",
]);

export class FrameReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async read(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      if (!this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) throw new ReaderError("native-transport-closed");
        this.pending = next.value;
      }
      const length = Math.min(size - offset, this.pending.length);
      this.pending.copy(result, offset, 0, length);
      this.pending = this.pending.subarray(length);
      offset += length;
    }
    return result;
  }
  async response(id: number, limit: number): Promise<Buffer> {
    const length = (await this.read(4)).readUInt32BE();
    if (length < 1 || length > CONTROL_LIMIT)
      throw new ReaderError("protocol-unsupported");
    let header;
    try {
      header = record(
        JSON.parse((await this.read(length)).toString("utf8")) as unknown,
      );
    } catch {
      throw new ReaderError("protocol-unsupported");
    }
    if (header.version !== 1 || header.id !== id)
      throw new ReaderError("protocol-unsupported");
    if (
      header.kind === "error" &&
      Object.keys(header).length === 4 &&
      typeof header.error === "string" &&
      NATIVE_ERRORS.has(header.error)
    )
      throw new ReaderError(header.error);
    if (header.kind !== "body" || Object.keys(header).length !== 4)
      throw new ReaderError("protocol-unsupported");
    const size = integer(header.length, 0, LIMITS.archive);
    if (size > limit) throw new ReaderError("response-too-large");
    return this.read(size);
  }
}

export class Account {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly frames: FrameReader;
  private readonly exited: Promise<void>;
  private closed = false;
  private inFlight = false;
  private id = 0;
  private constructor(
    executable: string,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.child = spawn(executable, ["--pipe"], {
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.frames = new FrameReader(this.child.stdout);
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => {
        this.child.stdout.destroy();
        resolve();
      });
    });
    this.child.stdin.on("error", () => {});
    signal.addEventListener("abort", this.abort, { once: true });
  }
  static async connect(
    executable: string,
    signal: AbortSignal,
    login = false,
  ): Promise<Account> {
    const account = new Account(executable, signal);
    try {
      await account.request({ kind: "connect", login });
      return account;
    } catch (error) {
      await account.close();
      throw error;
    }
  }
  private readonly abort = () => {
    void this.close();
  };
  async close(): Promise<void> {
    if (this.closed) return this.exited;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 1000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try {
      await this.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }
  private async request(input: Request): Promise<Buffer> {
    if (this.signal.aborted || this.closed)
      throw new ReaderError("interrupted");
    if (this.inFlight) throw new ReaderError("busy");
    const id = ++this.id,
      body = Buffer.from(JSON.stringify({ version: 1, id, ...input }));
    if (body.length > CONTROL_LIMIT)
      throw new ReaderError("protocol-unsupported");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    this.inFlight = true;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.close();
    }, LIMITS.requestMs + 2000);
    try {
      await new Promise<void>((resolve, reject) =>
        this.child.stdin.write(Buffer.concat([prefix, body]), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      return await this.frames.response(
        id,
        input.kind === "render"
          ? LIMITS.archive
          : input.kind === "connect"
            ? 0
            : LIMITS.json,
      );
    } catch (error) {
      if (timedOut) throw new ReaderError("request-timeout");
      if (this.signal.aborted) throw new ReaderError("interrupted");
      if (error instanceof ReaderError && NATIVE_ERRORS.has(error.kind))
        throw error;
      throw new ReaderError("network-error");
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }
  private async json(input: Request): Promise<unknown> {
    const bytes = await this.request(input);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new ReaderError("protocol-unsupported");
    }
  }
  async list() {
    return parseNotes(await this.json({ kind: "notes" }));
  }
  async openRaw(notebookId: string) {
    return this.json({ kind: "open", notebookId });
  }
  async open(notebookId: string) {
    return parseOpen(await this.openRaw(notebookId));
  }
  async render(page: number, token: string) {
    return this.request({ kind: "render", page, token });
  }
  async login(): Promise<void> {
    while (!this.closed && this.child.exitCode === null) {
      this.signal.throwIfAborted();
      try {
        await this.list();
        return;
      } catch (error) {
        if (
          !(error instanceof ReaderError) ||
          ![
            "authentication-required",
            "network-error",
            "service-error",
          ].includes(error.kind)
        )
          throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
    throw new ReaderError("login-cancelled");
  }
}
