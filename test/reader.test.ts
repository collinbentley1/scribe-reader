import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTar, validatePng, crc32 } from "../src/archive";
import { parseNotes, parseOpen, type NotebookMetadata } from "../src/domain";
import { parseCommand } from "../src/cli";
import { parseRenderedPage } from "../src/protocol";
import { syncNotebook, sha256, fingerprint } from "../src/snapshots";
import { pageArchive, png, tar } from "./fixtures";
import { deflateSync } from "node:zlib";
import { SETTINGS } from "../src/domain";
import { PROTOCOL } from "../src/protocol";
import type { SnapshotManifest } from "../src/snapshots";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "scribe-reader-test-"));
  temporary.push(path);
  return path;
}
const metadata: NotebookMetadata = {
  title: "Synthetic notebook",
  modificationTime: 1,
  totalPages: 2,
};
function remote(
  options: {
    before?: NotebookMetadata;
    after?: NotebookMetadata;
    seed?: number;
    abort?: AbortController;
  } = {},
) {
  let opens = 0,
    renders = 0;
  return {
    async open(_id: string) {
      opens++;
      if (opens % 2 === 0) options.abort?.abort();
      return {
        metadata:
          opens % 2 === 1
            ? (options.before ?? metadata)
            : (options.after ?? options.before ?? metadata),
        token: "synthetic-token",
      };
    },
    async render(page: number, _token: string) {
      renders++;
      return pageArchive(page, options.seed ?? 0);
    },
    get renders() {
      return renders;
    },
  };
}
async function sync(
  path: string,
  account = remote(),
  full = false,
  signal = new AbortController().signal,
) {
  return syncNotebook({
    root: path,
    account,
    notebookId: "synthetic-id",
    full,
    signal,
  });
}
async function pointer(path: string) {
  return readFile(
    join(path, "notebooks", sha256("synthetic-id"), "current"),
    "utf8",
  );
}

describe("external boundaries", () => {
  test("list parses nested folders and rejects duplicate identifiers", () => {
    const node = { id: "n", title: "Synthetic", type: "notebook", items: [] };
    expect(
      parseNotes({
        responseStatus: "OK",
        itemsList: [
          { id: "f", title: "Folder", type: "folder", items: [node] },
        ],
      })[0]?.kind,
    ).toBe("folder");
    expect(() =>
      parseNotes({ responseStatus: "OK", itemsList: [node, node] }),
    ).toThrow();
    expect(() =>
      parseNotes({ responseStatus: "ERROR", itemsList: [] }),
    ).toThrow("protocol-unsupported");
  });
  test("metadata preserves the opaque marker and excludes cursor and secrets", () => {
    const opened = parseOpen({
      metadata: { ...metadata, currentPage: 1 },
      renderingToken: "private",
      readingSessionId: "also-private",
    });
    expect(opened.metadata).toEqual(metadata);
    expect(() =>
      parseOpen({
        metadata: { ...metadata, totalPages: 1001 },
        renderingToken: "private",
      }),
    ).toThrow();
  });
  test("CLI rejects generic requests, arbitrary flags, and invalid page ordinals", () => {
    expect(parseCommand(["probe", "synthetic-id", "--page", "2"])).toEqual({
      kind: "probe",
      notebookId: "synthetic-id",
      ordinal: 2,
    });
    for (const args of [
      ["fetch", "https://example.com"],
      ["login", "--no-sandbox"],
      ["probe", "id", "--page", "0"],
      ["sync", "id", "--url", "anything"],
    ])
      expect(() => parseCommand(args)).toThrow("invalid-arguments");
  });
  test("tar validates framing, checksum, member type, duplicates, and exact coverage", () => {
    const bytes = pageArchive(0);
    expect(parseRenderedPage(bytes, 0).width).toBe(620);
    expect(() => readTar(bytes.subarray(0, -512))).toThrow("archive-invalid");
    const bad = Buffer.from(bytes);
    bad[0] = 255;
    expect(() => readTar(bad)).toThrow("archive-invalid");
    expect(() =>
      readTar(tar([{ name: "page-0.png", bytes: png(), type: "2" }])),
    ).toThrow("protocol-unsupported");
    expect(() =>
      readTar(
        tar([
          { name: "page-0.png", bytes: png() },
          { name: "page-0.png", bytes: png() },
        ]),
      ),
    ).toThrow("archive-invalid");
    expect(() => parseRenderedPage(pageArchive(1), 0)).toThrow(
      "protocol-unsupported",
    );
    expect(() =>
      parseRenderedPage(tar([{ name: "../../outside.png", bytes: png() }]), 0),
    ).toThrow("protocol-unsupported");
    expect(() =>
      parseRenderedPage(
        tar([
          { name: "page-0.png", bytes: png() },
          { name: "page-1.png", bytes: png() },
        ]),
        0,
      ),
    ).toThrow("page-coverage-invalid");
  });
  test("tar rejects unsupported format versions and member count overflow", () => {
    expect(() =>
      readTar(tar([{ name: "page-0.png", bytes: png() }], "ustar\0" + "01")),
    ).toThrow("protocol-unsupported");
    expect(() =>
      readTar(
        tar(
          Array.from({ length: 129 }, (_, i) => ({
            name: String(i),
            bytes: Buffer.alloc(0),
          })),
        ),
      ),
    ).toThrow("archive-too-many-members");
  });
  test("PNG decompression refuses output larger than the declared raster", () => {
    const original = png();
    const compressed = deflateSync(Buffer.alloc((620 * 4 + 1) * 877 + 1));
    const chunk = Buffer.alloc(compressed.length + 12);
    chunk.writeUInt32BE(compressed.length, 0);
    chunk.write("IDAT", 4);
    compressed.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const bomb = Buffer.concat([
      original.subarray(0, 33),
      chunk,
      original.subarray(-12),
    ]);
    expect(() => validatePng(bomb)).toThrow("image-invalid");
  });
  test("PNG rejects corruption, wrappers, trailing bytes, oversized dimensions, and unbounded interlace decoding", () => {
    const original = png();
    expect(validatePng(original)).toEqual({ width: 620, height: 877 });
    const corrupt = Buffer.from(original);
    corrupt[40] = (corrupt[40] ?? 0) ^ 1;
    expect(() => validatePng(corrupt)).toThrow("image-invalid");
    expect(() =>
      validatePng(Buffer.concat([Buffer.from("wrapper"), original])),
    ).toThrow("image-invalid");
    expect(() =>
      validatePng(Buffer.concat([original, Buffer.from("trailing")])),
    ).toThrow("image-invalid");
    const giant = Buffer.from(original);
    giant.writeUInt32BE(100_000, 16);
    giant.writeUInt32BE(crc32(giant.subarray(12, 29)), 29);
    expect(() => validatePng(giant)).toThrow("image-too-large");
    const interlaced = Buffer.from(original);
    interlaced[28] = 1;
    interlaced.writeUInt32BE(crc32(interlaced.subarray(12, 29)), 29);
    expect(() => validatePng(interlaced)).toThrow("protocol-unsupported");
  });
});

describe("immutable publication", () => {
  test("canonical identity ignores timestamps and includes metadata, settings, protocol, and page order", () => {
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      digest: "unused",
      notebookId: "synthetic-id",
      metadata,
      settings: SETTINGS,
      protocol: PROTOCOL,
      consistency: "metadata-bracketed",
      fetchedAt: "time-one",
      pages: [0, 1].map((index) => ({
        ordinal: index + 1,
        file: `page-${index + 1}.png`,
        sha256: sha256(png(index)),
        byteLength: 0,
        width: 620,
        height: 877,
        sourceMemberName: `page-${index}.png`,
        requestRange: { start: index, end: index },
      })),
    };
    const digest = fingerprint(manifest);
    expect(fingerprint({ ...manifest, fetchedAt: "time-two" })).toBe(digest);
    expect(
      fingerprint({ ...manifest, pages: [...manifest.pages].reverse() }),
    ).not.toBe(digest);
    expect(
      fingerprint({
        ...manifest,
        metadata: { ...metadata, title: "Another title" },
      }),
    ).not.toBe(digest);
    expect(
      fingerprint({ ...manifest, settings: { ...SETTINGS, dpi: 100 } }),
    ).not.toBe(digest);
    expect(
      fingerprint({ ...manifest, protocol: { ...PROTOCOL, version: "next" } }),
    ).not.toBe(digest);
  });
  test("receipts identify added, changed, and removed ordinal positions", async () => {
    const path = await root();
    const first = await sync(path);
    if (first.kind !== "snapshot-published") throw new Error("capture");
    expect(first.addedOrdinals).toEqual([1, 2]);
    const second = await sync(path, remote({ seed: 10 }), true);
    if (second.kind !== "snapshot-published") throw new Error("capture");
    expect(second.changedOrdinals).toEqual([1, 2]);
    expect(second.addedOrdinals).toEqual([]);
    const third = await sync(
      path,
      remote({ before: { ...metadata, totalPages: 1 }, seed: 10 }),
    );
    if (third.kind !== "snapshot-published") throw new Error("capture");
    expect(third.removedPageCount).toBe(1);
    expect(third.changedOrdinals).toEqual([]);
  });
  test("first sync publishes complete originals; metadata and full comparisons avoid churn", async () => {
    const path = await root(),
      first = await sync(path);
    expect(first.kind).toBe("snapshot-published");
    if (first.kind !== "snapshot-published") throw new Error("capture");
    expect(await readFile(join(first.directory, "page-0001.png"))).toEqual(
      png(),
    );
    const manifestPath = join(first.directory, "manifest.json"),
      before = await readFile(manifestPath);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    const secondRemote = remote();
    expect((await sync(path, secondRemote)).kind).toBe("metadata-match");
    expect(secondRemote.renders).toBe(0);
    const thirdRemote = remote();
    expect((await sync(path, thirdRemote, true)).kind).toBe("content-compared");
    expect(thirdRemote.renders).toBe(2);
    expect(await readFile(manifestPath)).toEqual(before);
    expect((await pointer(path)).trim()).toBe(first.digest);
    expect(before.toString()).not.toContain("synthetic-token");
  });
  test("full refresh detects changed bytes even with equal metadata", async () => {
    const path = await root();
    await sync(path);
    const old = await pointer(path);
    expect((await sync(path, remote({ seed: 10 }), true)).kind).toBe(
      "snapshot-published",
    );
    expect(await pointer(path)).not.toBe(old);
  });
  test("metadata changes publish a new manifest even when page bytes match", async () => {
    const path = await root();
    await sync(path);
    const old = await pointer(path);
    expect(
      (await sync(path, remote({ before: { ...metadata, title: "Renamed" } })))
        .kind,
    ).toBe("snapshot-published");
    expect(await pointer(path)).not.toBe(old);
  });
  test("remote changes and interruption preserve the last complete pointer", async () => {
    const path = await root();
    await sync(path);
    const old = await pointer(path);
    expect(
      await sync(
        path,
        remote({ after: { ...metadata, modificationTime: 2 } }),
        true,
      ),
    ).toEqual({ kind: "remote-changed" });
    expect(await pointer(path)).toBe(old);
    const abort = new AbortController();
    await expect(
      sync(path, remote({ seed: 20, abort }), true, abort.signal),
    ).rejects.toThrow();
    expect(await pointer(path)).toBe(old);
    const snapshots = join(
      path,
      "notebooks",
      sha256("synthetic-id"),
      "snapshots",
    );
    expect(
      (await readdir(snapshots)).some((name) => name.startsWith(".staging-")),
    ).toBe(false);
  });
  test("a complete orphan is reused only after a new successful capture", async () => {
    const path = await root(),
      first = await sync(path);
    if (first.kind !== "snapshot-published") throw new Error("capture");
    const before = await readFile(join(first.directory, "manifest.json"));
    await rm(join(path, "notebooks", sha256("synthetic-id"), "current"));
    const account = remote();
    expect((await sync(path, account)).kind).toBe("snapshot-published");
    expect(account.renders).toBe(2);
    expect(await readFile(join(first.directory, "manifest.json"))).toEqual(
      before,
    );
    expect((await pointer(path)).trim()).toBe(first.digest);
  });
  test("tampered member provenance prevents the metadata fast path", async () => {
    const path = await root(),
      first = await sync(path);
    if (first.kind !== "snapshot-published") throw new Error("capture");
    const manifestPath = join(first.directory, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const tampered = original.replace(
      '"sourceMemberName": "page-0.png"',
      '"sourceMemberName": "page-999.png"',
    );
    expect(tampered).not.toBe(original);
    await writeFile(manifestPath, tampered);
    const account = remote();
    await expect(sync(path, account)).rejects.toThrow("snapshot-invalid");
    expect(account.renders).toBe(0);
    expect((await pointer(path)).trim()).toBe(first.digest);
    expect(await readFile(join(first.directory, "page-0001.png"))).toEqual(
      png(),
    );
  });
  test("corrupt current pages are refused and partial staging is cleaned on retry", async () => {
    const path = await root(),
      first = await sync(path);
    if (first.kind !== "snapshot-published") throw new Error("capture");
    await writeFile(join(first.directory, "page-0001.png"), "bad");
    await expect(sync(path)).rejects.toThrow("image-invalid");
    const newPath = await root(),
      staging = join(
        newPath,
        "notebooks",
        sha256("synthetic-id"),
        "snapshots",
        ".staging-dead",
      );
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "partial"), "incomplete");
    await sync(newPath);
    expect(
      (await readdir(join(staging, ".."))).some((name) =>
        name.startsWith(".staging-"),
      ),
    ).toBe(false);
  });
});
