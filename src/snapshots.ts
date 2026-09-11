import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { Account } from "./account.js";
import {
  integer,
  LIMITS,
  type NotebookMetadata,
  ReaderError,
  record,
  sameMetadata,
  SETTINGS,
  string,
} from "./domain.js";
import { matchesPageMember, parseRenderedPage, PROTOCOL } from "./protocol.js";
import { validatePng } from "./archive.js";

export type PageRecord = {
  ordinal: number;
  file: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  sourceMemberName: string;
  requestRange: { start: number; end: number };
};
export type SnapshotManifest = {
  schemaVersion: 1;
  digest: string;
  notebookId: string;
  metadata: NotebookMetadata;
  settings: typeof SETTINGS;
  protocol: typeof PROTOCOL;
  consistency: "metadata-bracketed";
  fetchedAt: string;
  pages: PageRecord[];
};
export type SyncOutcome =
  | {
      kind: "metadata-match" | "content-compared" | "snapshot-published";
      digest: string;
      directory: string;
      comparedPageBytes: boolean;
      consistency: "metadata-bracketed";
      changedOrdinals: number[];
      addedOrdinals: number[];
      removedPageCount: number;
    }
  | { kind: "remote-changed" };
export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function fingerprint(
  manifest: Omit<SnapshotManifest, "digest" | "fetchedAt">,
): string {
  return sha256(
    canonical({
      schemaVersion: manifest.schemaVersion,
      notebookId: manifest.notebookId,
      metadata: manifest.metadata,
      settings: manifest.settings,
      protocol: manifest.protocol,
      hashes: manifest.pages.map((page) => page.sha256),
    }),
  );
}
async function durableWrite(path: string, bytes: Buffer | string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function flushDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readBounded(path: string, max: number): Promise<Buffer> {
  if ((await stat(path)).size > max) throw new ReaderError("snapshot-invalid");
  const bytes = await readFile(path);
  if (bytes.length > max) throw new ReaderError("snapshot-invalid");
  return bytes;
}
async function validateSnapshot(
  directory: string,
  digest: string,
): Promise<SnapshotManifest> {
  const raw = record(
    JSON.parse(
      (
        await readBounded(join(directory, "manifest.json"), LIMITS.json)
      ).toString("utf8"),
    ) as unknown,
  );
  if (
    raw.schemaVersion !== 1 ||
    raw.digest !== digest ||
    raw.consistency !== "metadata-bracketed"
  )
    throw new ReaderError("snapshot-invalid");
  const meta = record(raw.metadata),
    settings = record(raw.settings),
    protocol = record(raw.protocol);
  const marker = meta.modificationTime;
  if (!(
    (typeof marker === "number" && Number.isFinite(marker)) ||
    (typeof marker === "string" && marker.length > 0 && marker.length <= 1024)
  ))
    throw new ReaderError("snapshot-invalid");
  const savedSettings = {
    marketplaceId: string(settings.marketplaceId),
    width: integer(settings.width, 1, 10000),
    height: integer(settings.height, 1, 10000),
    dpi: integer(settings.dpi, 1, 1000),
  };
  if (
    typeof protocol.verified !== "boolean" ||
    protocol.indexOrigin !== 0 ||
    protocol.endBound !== "inclusive" ||
    typeof protocol.framing !== "string"
  )
    throw new ReaderError("snapshot-invalid");
  const savedProtocol = {
    version: string(protocol.version),
    verified: protocol.verified,
    indexOrigin: 0,
    endBound: "inclusive",
    framing: protocol.framing,
  };
  const metadata = {
    title: string(meta.title, 4096),
    modificationTime: marker,
    totalPages: integer(meta.totalPages, 0, LIMITS.pages),
  };
  if (!Array.isArray(raw.pages) || raw.pages.length !== metadata.totalPages)
    throw new ReaderError("snapshot-invalid");
  let total = 0;
  const pages: PageRecord[] = [];
  for (const [index, item] of raw.pages.entries()) {
    const page = record(item),
      range = record(page.requestRange),
      sourceMemberName = string(page.sourceMemberName, 255),
      file = `page-${String(index + 1).padStart(4, "0")}.png`;
    if (
      page.ordinal !== index + 1 ||
      page.file !== file ||
      range.start !== index ||
      range.end !== index ||
      !matchesPageMember(sourceMemberName, index)
    )
      throw new ReaderError("snapshot-invalid");
    const bytes = await readBounded(join(directory, file), LIMITS.png),
      dimensions = validatePng(bytes);
    total += bytes.length;
    if (
      total > LIMITS.capture ||
      page.sha256 !== sha256(bytes) ||
      page.byteLength !== bytes.length ||
      page.width !== dimensions.width ||
      page.height !== dimensions.height
    )
      throw new ReaderError("snapshot-invalid");
    pages.push({
      ordinal: index + 1,
      file,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      ...dimensions,
      sourceMemberName,
      requestRange: { start: index, end: index },
    });
  }
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    digest,
    notebookId: string(raw.notebookId),
    metadata,
    settings: savedSettings,
    protocol: savedProtocol,
    consistency: "metadata-bracketed",
    fetchedAt: string(raw.fetchedAt),
    pages,
  };
  if (fingerprint(manifest) !== digest)
    throw new ReaderError("snapshot-invalid");
  return manifest;
}
export async function syncNotebook({
  account,
  root,
  notebookId,
  full,
  signal,
}: {
  account: Pick<Account, "open" | "render">;
  root: string;
  notebookId: string;
  full: boolean;
  signal: AbortSignal;
}): Promise<SyncOutcome> {
  signal.throwIfAborted();
  const notebookRoot = join(root, "notebooks", sha256(notebookId)),
    snapshots = join(notebookRoot, "snapshots");
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  let previous: SnapshotManifest | undefined;
  let pointer: string | undefined;
  try {
    pointer = (await readBounded(join(notebookRoot, "current"), 65))
      .toString("ascii")
      .trim();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (pointer !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(pointer))
      throw new ReaderError("snapshot-invalid");
    previous = await validateSnapshot(join(snapshots, pointer), pointer);
    if (previous.notebookId !== notebookId)
      throw new ReaderError("snapshot-invalid");
  }
  const before = await account.open(notebookId);
  if (
    previous &&
    !full &&
    sameMetadata(previous.metadata, before.metadata) &&
    canonical(previous.settings) === canonical(SETTINGS) &&
    canonical(previous.protocol) === canonical(PROTOCOL)
  )
    return {
      kind: "metadata-match",
      digest: previous.digest,
      directory: join(snapshots, previous.digest),
      comparedPageBytes: false,
      consistency: "metadata-bracketed",
      changedOrdinals: [],
      addedOrdinals: [],
      removedPageCount: 0,
    };
  for (const name of await readdir(snapshots))
    if (name.startsWith(".staging-"))
      await rm(join(snapshots, name), { recursive: true, force: true });
  const staging = join(snapshots, ".staging-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    const pages: PageRecord[] = [];
    let total = 0;
    for (let page = 0; page < before.metadata.totalPages; page++) {
      signal.throwIfAborted();
      const rendered = parseRenderedPage(
        await account.render(page, before.token),
        page,
      );
      total += rendered.bytes.length;
      if (total > LIMITS.capture) throw new ReaderError("capture-too-large");
      const file = `page-${String(page + 1).padStart(4, "0")}.png`;
      await durableWrite(join(staging, file), rendered.bytes);
      pages.push({
        ordinal: page + 1,
        file,
        sha256: sha256(rendered.bytes),
        byteLength: rendered.bytes.length,
        width: rendered.width,
        height: rendered.height,
        sourceMemberName: rendered.name,
        requestRange: { start: page, end: page },
      });
    }
    const after = await account.open(notebookId);
    if (!sameMetadata(before.metadata, after.metadata))
      return { kind: "remote-changed" };
    signal.throwIfAborted();
    const content = {
      schemaVersion: 1 as const,
      notebookId,
      metadata: before.metadata,
      settings: SETTINGS,
      protocol: PROTOCOL,
      consistency: "metadata-bracketed" as const,
      pages,
    };
    const digest = fingerprint(content),
      directory = join(snapshots, digest);
    if (previous?.digest === digest)
      return {
        kind: "content-compared",
        digest,
        directory,
        comparedPageBytes: true,
        consistency: "metadata-bracketed",
        changedOrdinals: [],
        addedOrdinals: [],
        removedPageCount: 0,
      };
    const manifest: SnapshotManifest = {
      ...content,
      digest,
      fetchedAt: new Date().toISOString(),
    };
    await durableWrite(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await flushDirectory(staging);
    try {
      await validateSnapshot(directory, digest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await rename(staging, directory);
      await flushDirectory(snapshots);
    }
    signal.throwIfAborted();
    const pointer = join(notebookRoot, ".current-" + randomUUID());
    await durableWrite(pointer, digest + "\n");
    try {
      signal.throwIfAborted();
      await rename(pointer, join(notebookRoot, "current"));
      await flushDirectory(notebookRoot);
    } finally {
      await rm(pointer, { force: true });
    }
    return {
      kind: "snapshot-published",
      digest,
      directory,
      comparedPageBytes: true,
      consistency: "metadata-bracketed",
      changedOrdinals: pages
        .filter(
          (page) =>
            previous?.pages[page.ordinal - 1] &&
            previous.pages[page.ordinal - 1]?.sha256 !== page.sha256,
        )
        .map((page) => page.ordinal),
      addedOrdinals: pages
        .filter((page) => !previous?.pages[page.ordinal - 1])
        .map((page) => page.ordinal),
      removedPageCount: Math.max(
        0,
        (previous?.pages.length ?? 0) - pages.length,
      ),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
