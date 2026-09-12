import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deterministicBytes,
  JSON_LIMIT_BYTES,
  normalJson,
  renderArchive,
  RENDER_LIMIT_BYTES,
  sizedJson,
  SYNTHETIC_MARKETPLACE_ID,
  SYNTHETIC_NOTEBOOK_ID,
  SYNTHETIC_RENDERING_TOKEN,
  type JsonEndpoint,
} from "./responses.js";

export const FIXTURE_ORIGIN = "https://localhost:18443";
const FIXTURE_COOKIE = "fixture_session=synthetic";
const REDIRECT_MARKER = "fixtureRedirected";
const directory = dirname(fileURLToPath(import.meta.url));
export const CERTIFICATE_PATH = join(directory, "localhost-cert.pem");
export const PRIVATE_KEY_PATH = join(directory, "localhost-key.pem");
const certificatePem = readFileSync(CERTIFICATE_PATH, "utf8");
const privateKeyPem = readFileSync(PRIVATE_KEY_PATH, "utf8");
export const CERTIFICATE_SHA256_DER = createHash("sha256")
  .update(new X509Certificate(certificatePem).raw)
  .digest("hex");

export type FixtureScenario =
  | "normal"
  | "same-origin-redirect"
  | "cross-origin-redirect"
  | "json-2mib-exact"
  | "json-2mib-over"
  | "render-64mib-exact"
  | "render-64mib-over"
  | "slow-cancellation";

export type FixtureEndpoint = "root" | "notes" | "open" | "render" | "unknown";

export type FixtureObservation = Readonly<{
  endpoint: FixtureEndpoint;
  cookie: string | null;
  renderingToken: string | null;
  query: Readonly<Record<string, string>>;
}>;

export type FixtureSnapshot = Readonly<{
  scenario: FixtureScenario;
  requestCounts: Readonly<Record<FixtureEndpoint, number>>;
  observations: readonly FixtureObservation[];
  activeRequests: number;
  maxInflight: number;
  cancelledBodies: number;
}>;

export type FixtureControl = Readonly<{
  origin: typeof FIXTURE_ORIGIN;
  certificatePath: string;
  privateKeyPath: string;
  certificateSha256Der: string;
  setScenario(scenario: FixtureScenario): void;
  snapshot(): FixtureSnapshot;
  stop(): Promise<void>;
}>;

type MutableState = {
  scenario: FixtureScenario;
  requestCounts: Record<FixtureEndpoint, number>;
  observations: FixtureObservation[];
  activeRequests: number;
  maxInflight: number;
  cancelledBodies: number;
};

function emptyCounts(): Record<FixtureEndpoint, number> {
  return { root: 0, notes: 0, open: 0, render: 0, unknown: 0 };
}

function endpoint(pathname: string): FixtureEndpoint {
  switch (pathname) {
    case "/":
      return "root";
    case "/kindle-notebook/api/notes":
      return "notes";
    case "/openNotebook":
      return "open";
    case "/renderPage":
      return "render";
    default:
      return "unknown";
  }
}

function query(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) result[key] = value;
  return result;
}

function queryMatches(
  url: URL,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actual = new URLSearchParams(url.searchParams);
  actual.delete(REDIRECT_MARKER);
  if (actual.size !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(
    ([key, value]) => actual.get(key) === value,
  );
}

function begin(state: MutableState): (cancelled: boolean) => void {
  state.activeRequests++;
  state.maxInflight = Math.max(state.maxInflight, state.activeRequests);
  let finished = false;
  return (cancelled: boolean) => {
    if (finished) return;
    finished = true;
    state.activeRequests--;
    if (cancelled) state.cancelledBodies++;
  };
}

function byteStream(args: {
  size: number;
  bytes?: Buffer;
  delayMs: number;
  signal: AbortSignal;
  finish: (cancelled: boolean) => void;
}): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let offset = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  const finish = (cancelled: boolean) => {
    if (stopped) return;
    stopped = true;
    args.signal.removeEventListener("abort", abort);
    args.finish(cancelled);
  };
  const abort = () => {
    finish(true);
    controller?.error(new Error("fixture-client-aborted"));
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      args.signal.addEventListener("abort", abort, { once: true });
    },
    async pull(value) {
      if (stopped) return;
      if (args.delayMs > 0) await Bun.sleep(args.delayMs);
      if (stopped) return;
      const length = Math.min(chunkSize, args.size - offset);
      if (length <= 0) {
        value.close();
        finish(false);
        return;
      }
      value.enqueue(
        args.bytes?.subarray(offset, offset + length) ??
          deterministicBytes(offset, length),
      );
      offset += length;
      if (offset === args.size) {
        value.close();
        finish(false);
      }
    },
    cancel() {
      finish(true);
    },
  });
}

function bodyResponse(args: {
  bytes?: Buffer;
  size: number;
  contentType: string;
  delayMs?: number;
  request: Request;
  finish: (cancelled: boolean) => void;
  headers?: Readonly<Record<string, string>>;
}): Response {
  return new Response(
    byteStream({
      size: args.size,
      ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
      delayMs: args.delayMs ?? 0,
      signal: args.request.signal,
      finish: args.finish,
    }),
    {
      status: 200,
      headers: {
        "content-type": args.contentType,
        "content-length": String(args.size),
        ...args.headers,
      },
    },
  );
}

function invalid(finish: (cancelled: boolean) => void): Response {
  finish(false);
  return new Response("invalid fixture request", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function redirected(
  scenario: FixtureScenario,
  url: URL,
  finish: (cancelled: boolean) => void,
): Response | undefined {
  if (scenario === "cross-origin-redirect") {
    finish(false);
    return Response.redirect("https://example.invalid/blocked", 302);
  }
  if (
    scenario === "same-origin-redirect" &&
    url.searchParams.get(REDIRECT_MARKER) !== "1"
  ) {
    const destination = new URL(url);
    destination.searchParams.set(REDIRECT_MARKER, "1");
    finish(false);
    return Response.redirect(destination, 302);
  }
  return undefined;
}

function jsonEndpoint(value: FixtureEndpoint): JsonEndpoint | undefined {
  if (value === "notes") return "notes";
  if (value === "open") return "open";
  return undefined;
}

export function startFixture(): FixtureControl {
  const state: MutableState = {
    scenario: "normal",
    requestCounts: emptyCounts(),
    observations: [],
    activeRequests: 0,
    maxInflight: 0,
    cancelledBodies: 0,
  };

  const server = Bun.serve({
    hostname: "localhost",
    port: 18443,
    tls: { cert: certificatePem, key: privateKeyPem },
    fetch(request) {
      const url = new URL(request.url);
      const requestEndpoint = endpoint(url.pathname);
      state.requestCounts[requestEndpoint]++;
      state.observations.push({
        endpoint: requestEndpoint,
        cookie: request.headers.get("cookie"),
        renderingToken: request.headers.get(
          "x-amzn-karamel-notebook-rendering-token",
        ),
        query: query(url),
      });
      const finish = begin(state);

      if (url.origin !== FIXTURE_ORIGIN) return invalid(finish);
      if (requestEndpoint === "unknown") {
        finish(false);
        return new Response("not found", { status: 404 });
      }
      if (requestEndpoint === "root") {
        if (!queryMatches(url, {})) return invalid(finish);
        const bytes = Buffer.from(
          "<!doctype html><title>Native fixture</title>",
        );
        return bodyResponse({
          bytes,
          size: bytes.length,
          contentType: "text/html; charset=utf-8",
          request,
          finish,
          headers: {
            "set-cookie": `${FIXTURE_COOKIE}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
          },
        });
      }

      const redirect = redirected(state.scenario, url, finish);
      if (redirect) return redirect;

      if (requestEndpoint === "notes") {
        if (!queryMatches(url, {})) return invalid(finish);
      } else if (requestEndpoint === "open") {
        if (
          !queryMatches(url, {
            notebookId: SYNTHETIC_NOTEBOOK_ID,
            marketplaceId: SYNTHETIC_MARKETPLACE_ID,
          })
        )
          return invalid(finish);
      } else {
        const page = url.searchParams.get("startPage");
        if (
          page === null ||
          !/^(?:[0-9]|[1-7][0-9]|8[0-2])$/.test(page) ||
          !queryMatches(url, {
            startPage: page,
            endPage: page,
            width: "620",
            height: "877",
            dpi: "50",
          }) ||
          request.headers.get("x-amzn-karamel-notebook-rendering-token") !==
            SYNTHETIC_RENDERING_TOKEN
        )
          return invalid(finish);
      }

      const structured = jsonEndpoint(requestEndpoint);
      if (structured !== undefined) {
        const bytes =
          state.scenario === "json-2mib-exact"
            ? sizedJson(structured, JSON_LIMIT_BYTES)
            : state.scenario === "json-2mib-over"
              ? sizedJson(structured, JSON_LIMIT_BYTES + 1)
              : normalJson(structured);
        return bodyResponse({
          bytes,
          size: bytes.length,
          contentType: "application/json; charset=utf-8",
          request,
          finish,
        });
      }

      const page = Number(url.searchParams.get("startPage"));
      if (state.scenario === "render-64mib-exact")
        return bodyResponse({
          size: RENDER_LIMIT_BYTES,
          contentType: "application/octet-stream",
          request,
          finish,
        });
      if (state.scenario === "render-64mib-over")
        return bodyResponse({
          size: RENDER_LIMIT_BYTES + 1,
          contentType: "application/octet-stream",
          request,
          finish,
        });
      if (state.scenario === "slow-cancellation")
        return bodyResponse({
          size: RENDER_LIMIT_BYTES,
          contentType: "application/octet-stream",
          delayMs: 25,
          request,
          finish,
        });
      const bytes = renderArchive(page);
      return bodyResponse({
        bytes,
        size: bytes.length,
        contentType: "application/octet-stream",
        request,
        finish,
      });
    },
  });

  return {
    origin: FIXTURE_ORIGIN,
    certificatePath: CERTIFICATE_PATH,
    privateKeyPath: PRIVATE_KEY_PATH,
    certificateSha256Der: CERTIFICATE_SHA256_DER,
    setScenario(scenario) {
      if (state.activeRequests !== 0)
        throw new Error("fixture-requests-active");
      state.scenario = scenario;
      state.requestCounts = emptyCounts();
      state.observations = [];
      state.maxInflight = 0;
      state.cancelledBodies = 0;
    },
    snapshot() {
      return {
        scenario: state.scenario,
        requestCounts: { ...state.requestCounts },
        observations: state.observations.map((observation) => ({
          ...observation,
          query: { ...observation.query },
        })),
        activeRequests: state.activeRequests,
        maxInflight: state.maxInflight,
        cancelledBodies: state.cancelledBodies,
      };
    },
    async stop() {
      await server.stop(true);
    },
  };
}
