import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { FrameReader } from "../src/account.js";
import { LIMITS, safeShape } from "../src/domain.js";

test("probe shape diagnostics retain types without tokens or scalar values", () => {
  const raw = {
    renderingToken: "synthetic-private-token",
    nested: { title: "private-title", marker: 123, active: true },
    absent: null,
  };
  expect(safeShape(raw)).toEqual({
    renderingToken: "string",
    nested: { title: "string", marker: "number", active: "boolean" },
    absent: "null",
  });
  expect(JSON.stringify(safeShape(raw))).not.toContain(
    "synthetic-private-token",
  );
});

function frame(header: unknown, body = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  return Buffer.concat([prefix, json, body]);
}
function reader(bytes: Buffer, split = bytes.length): FrameReader {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += split)
    chunks.push(bytes.subarray(offset, offset + split));
  return new FrameReader(Readable.from(chunks));
}

test("native frames preserve fragmented binary bodies and separate consecutive responses", async () => {
  const body = Buffer.from([0, 255, 10, 13, 128]);
  const frames = reader(
    Buffer.concat([
      frame({ version: 1, id: 1, kind: "body", length: body.length }, body),
      frame({ version: 1, id: 2, kind: "body", length: 0 }),
    ]),
    1,
  );
  expect(await frames.response(1, 10)).toEqual(body);
  expect(await frames.response(2, 0)).toEqual(Buffer.alloc(0));
});

test("native frame headers reject identity, shape, and endpoint size violations before allocation", async () => {
  for (const header of [
    { version: true, id: 1, kind: "body", length: 0 },
    { version: 1, id: true, kind: "body", length: 0 },
    { version: 1, id: 2, kind: "body", length: 0 },
    { version: 1, id: 1, kind: "body", length: true },
    { version: 1, id: 1, kind: "body", length: -1 },
    { version: 1, id: 1, kind: "body", length: 0, extra: true },
    { version: 1, id: 1, kind: "error", error: "private-upstream-body" },
  ])
    await expect(
      reader(frame(header)).response(1, LIMITS.json),
    ).rejects.toThrow("protocol-unsupported");
  await expect(
    reader(
      frame({ version: 1, id: 1, kind: "body", length: LIMITS.json + 1 }),
    ).response(1, LIMITS.json),
  ).rejects.toThrow("response-too-large");
  const excessiveControl = Buffer.alloc(4);
  excessiveControl.writeUInt32BE(65_537);
  await expect(
    reader(excessiveControl).response(1, LIMITS.json),
  ).rejects.toThrow("protocol-unsupported");
});

test("native frame truncation cannot return a partial body and errors stay bounded", async () => {
  await expect(
    reader(
      frame(
        { version: 1, id: 1, kind: "body", length: 3 },
        Buffer.from([1, 2]),
      ),
    ).response(1, 10),
  ).rejects.toThrow("native-transport-closed");
  await expect(
    reader(
      frame({
        version: 1,
        id: 1,
        kind: "error",
        error: "authentication-required",
      }),
    ).response(1, 10),
  ).rejects.toThrow("authentication-required");
});
