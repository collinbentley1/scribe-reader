export class ReaderError extends Error {
  constructor(public readonly kind: string) {
    super(kind);
  }
}
export type Notebook =
  | { kind: "notebook"; id: string; title: string }
  | { kind: "folder"; id: string; title: string; items: Notebook[] };
export type NotebookMetadata = {
  title: string;
  modificationTime: number | string;
  totalPages: number;
};
export const SETTINGS = {
  marketplaceId: "ATVPDKIKX0DER",
  width: 620,
  height: 877,
  dpi: 50,
};
export const LIMITS = {
  json: 2 * 1024 ** 2,
  archive: 64 * 1024 ** 2,
  png: 16 * 1024 ** 2,
  pixels: 20_000_000,
  pages: 1000,
  members: 128,
  capture: 1024 ** 3,
  requestMs: 30_000,
  syncMs: 600_000,
};
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ReaderError("protocol-unsupported");
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new ReaderError("protocol-unsupported");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ReaderError("protocol-unsupported");
  return value;
}
export function parseNotes(value: unknown): Notebook[] {
  const body = record(value);
  if (body.responseStatus !== "OK")
    throw new ReaderError("protocol-unsupported");
  let count = 0;
  const ids = new Set<string>();
  function walk(value: unknown, depth: number): Notebook[] {
    if (!Array.isArray(value) || depth > 32)
      throw new ReaderError("protocol-unsupported");
    return value.map((raw: unknown) => {
      if (++count > 10_000) throw new ReaderError("response-too-large");
      const node = record(raw),
        id = string(node.id),
        title = string(node.title, 4096);
      if (ids.has(id)) throw new ReaderError("protocol-unsupported");
      ids.add(id);
      if (node.type === "folder")
        return {
          kind: "folder",
          id,
          title,
          items: walk(node.items, depth + 1),
        };
      if (
        node.type !== "notebook" ||
        !Array.isArray(node.items) ||
        node.items.length !== 0
      )
        throw new ReaderError("protocol-unsupported");
      return { kind: "notebook", id, title };
    });
  }
  return walk(body.itemsList, 0);
}
export function parseOpen(value: unknown): {
  metadata: NotebookMetadata;
  token: string;
} {
  const body = record(value),
    meta = record(body.metadata);
  const marker = meta.modificationTime;
  if (!(
    (typeof marker === "number" && Number.isFinite(marker)) ||
    (typeof marker === "string" && marker.length > 0 && marker.length <= 1024)
  ))
    throw new ReaderError("protocol-unsupported");
  return {
    metadata: {
      title: string(meta.title, 4096),
      modificationTime: marker,
      totalPages: integer(meta.totalPages, 0, LIMITS.pages),
    },
    token: string(body.renderingToken, 16_384),
  };
}
export function sameMetadata(
  a: NotebookMetadata,
  b: NotebookMetadata,
): boolean {
  return (
    a.title === b.title &&
    a.modificationTime === b.modificationTime &&
    a.totalPages === b.totalPages
  );
}
export function safeShape(value: unknown, depth = 0): unknown {
  if (depth >= 3) return typeof value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, child]) => [key, safeShape(child, depth + 1)]),
    );
  return value === null ? "null" : typeof value;
}
