import { BrowserWindow, net, type Session } from "electron";
import {
  LIMITS,
  parseNotes,
  parseOpen,
  ReaderError,
  SETTINGS,
} from "./domain.js";

type Request =
  | { kind: "notes" }
  | { kind: "open"; notebookId: string }
  | { kind: "render"; page: number; token: string };
export class Account {
  constructor(
    private readonly session: Session,
    private readonly signal: AbortSignal,
  ) {}
  private request(input: Request): Promise<Buffer> {
    this.signal.throwIfAborted();
    const url = new URL("https://read.amazon.com");
    let limit = LIMITS.json;
    if (input.kind === "notes") url.pathname = "/kindle-notebook/api/notes";
    if (input.kind === "open") {
      url.pathname = "/openNotebook";
      url.search = new URLSearchParams({
        notebookId: input.notebookId,
        marketplaceId: SETTINGS.marketplaceId,
      }).toString();
    }
    if (input.kind === "render") {
      url.pathname = "/renderPage";
      url.search = new URLSearchParams({
        startPage: String(input.page),
        endPage: String(input.page),
        width: String(SETTINGS.width),
        height: String(SETTINGS.height),
        dpi: String(SETTINGS.dpi),
      }).toString();
      limit = LIMITS.archive;
    }
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: "GET",
        url: url.href,
        session: this.session,
        useSessionCookies: true,
        redirect: "manual",
      });
      let finished = false;
      const finish = (error?: ReaderError, bytes?: Buffer) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        if (error) {
          request.abort();
          reject(error);
        } else resolve(bytes ?? Buffer.alloc(0));
      };
      const abort = () => finish(new ReaderError("interrupted"));
      const timer = setTimeout(
        () => finish(new ReaderError("request-timeout")),
        LIMITS.requestMs,
      );
      this.signal.addEventListener("abort", abort, { once: true });
      request.on("redirect", () =>
        finish(new ReaderError("authentication-required")),
      );
      request.on("login", (_info, callback) => {
        callback();
        finish(new ReaderError("authentication-required"));
      });
      request.on("error", () => finish(new ReaderError("network-error")));
      if (input.kind === "render")
        request.setHeader(
          "x-amzn-karamel-notebook-rendering-token",
          input.token,
        );
      request.on("response", (response) => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          finish(new ReaderError("authentication-required"));
          return;
        }
        if (response.statusCode !== 200) {
          finish(new ReaderError("service-error"));
          return;
        }
        const type = response.headers["content-type"];
        if (String(type).toLowerCase().includes("text/html")) {
          finish(new ReaderError("authentication-required"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (finished) return;
          size += chunk.length;
          if (size > limit) {
            finish(new ReaderError("response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => finish(new ReaderError("network-error")));
        response.on("end", () =>
          finish(undefined, Buffer.concat(chunks, size)),
        );
      });
      request.end();
    });
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
    const window = new BrowserWindow({
      width: 1050,
      height: 850,
      title: "Scribe Reader sign in",
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event: Electron.Event, destination: string) => {
      try {
        const url = new URL(destination);
        if (
          url.protocol !== "https:" ||
          url.port ||
          url.username ||
          url.password ||
          !["read.amazon.com", "www.amazon.com", "amazon.com"].includes(
            url.hostname,
          )
        )
          event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", guard);
    void window.loadURL("https://read.amazon.com/").catch(() => {});
    try {
      while (!window.isDestroyed()) {
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
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }
}
