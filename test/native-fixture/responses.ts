import { pageArchive } from "../fixtures.js";

export const JSON_LIMIT_BYTES = 2 * 1024 ** 2;
export const RENDER_LIMIT_BYTES = 64 * 1024 ** 2;
export const SYNTHETIC_NOTEBOOK_ID = "synthetic-id";
export const SYNTHETIC_RENDERING_TOKEN = "synthetic-rendering-token";
export const SYNTHETIC_MARKETPLACE_ID = "ATVPDKIKX0DER";

export type JsonEndpoint = "notes" | "open";

const notes = {
  responseStatus: "OK",
  itemsList: [
    {
      id: SYNTHETIC_NOTEBOOK_ID,
      title: "Synthetic notebook",
      type: "notebook",
      items: [],
    },
  ],
};

const open = {
  metadata: {
    title: "Synthetic notebook",
    modificationTime: 1,
    totalPages: 83,
  },
  renderingToken: SYNTHETIC_RENDERING_TOKEN,
};

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

export function normalJson(endpoint: JsonEndpoint): Buffer {
  switch (endpoint) {
    case "notes":
      return json(notes);
    case "open":
      return json(open);
    default: {
      const exhaustive: never = endpoint;
      return exhaustive;
    }
  }
}

export function sizedJson(endpoint: JsonEndpoint, byteLength: number): Buffer {
  const base = normalJson(endpoint).toString("utf8");
  if (!base.endsWith("}")) throw new Error("fixture-json-shape");
  const prefix = base.slice(0, -1) + ',"fixturePadding":"';
  const suffix = '"}';
  const paddingLength =
    byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (paddingLength < 0) throw new Error("fixture-json-size");
  const result = Buffer.from(prefix + "x".repeat(paddingLength) + suffix);
  if (result.length !== byteLength) throw new Error("fixture-json-size");
  return result;
}

export function renderArchive(page: number): Buffer {
  return pageArchive(page, page % 256);
}

export function deterministicBytes(offset: number, byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  for (let index = 0; index < byteLength; index++)
    bytes[index] = (offset + index) % 251;
  return bytes;
}
