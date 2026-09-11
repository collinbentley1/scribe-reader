import { describe, expect, test } from "bun:test";
import { readTar } from "../src/archive";
import { record } from "../src/domain";
import { parseRenderedPage } from "../src/protocol";
import { paxPayload, renderMembers, tar, withPax } from "./fixtures";

const position = 82;
const context = { notebookId: "synthetic-id", page: position };
const members = renderMembers(position);
function replaceJson(name: string, value: unknown) {
  return members.map((member) =>
    member.name === name
      ? { ...member, bytes: Buffer.from(JSON.stringify(value)) }
      : member,
  );
}
function pageWith(change: (page: Record<string, unknown>) => void) {
  const name = `page_data_${position}_${position}.json`;
  const member = members.find((member) => member.name === name);
  if (!member) throw new Error("fixture member");
  const data: unknown = JSON.parse(member.bytes.toString("utf8"));
  if (!Array.isArray(data)) throw new Error("fixture pages");
  const page = record(data[0]);
  change(page);
  return tar(withPax(replaceJson(name, [page])));
}
function imageWith(change: (image: Record<string, unknown>) => void) {
  return pageWith((page) => {
    if (!Array.isArray(page.children)) throw new Error("fixture children");
    change(record(page.children[0]));
  });
}

describe("observed single-page mapping", () => {
  test("entry order and local image index do not change the global position", () => {
    const image = parseRenderedPage(
      tar(withPax([...members].reverse())),
      context,
    );
    expect(image.name).toBe("img_0.png");
    expect(image.width).toBe(1860);
    expect(image.height).toBe(2480);
    expect(image.bytes).toEqual(
      members.find((member) => member.name === "img_0.png")?.bytes,
    );
  });
  test("manifest must bind the requested notebook and describe a complete fixed notebook", () => {
    const member = members.find((member) => member.name === "manifest.json");
    if (!member) throw new Error("fixture manifest");
    const manifest = record(
      JSON.parse(member.bytes.toString("utf8")) as unknown,
    );
    for (const patch of [
      { asin: "another-synthetic-id" },
      { manifestComplete: false },
      { bookType: "Reflowable" },
    ]) {
      expect(() =>
        parseRenderedPage(
          tar(withPax(replaceJson("manifest.json", { ...manifest, ...patch }))),
          context,
        ),
      ).toThrow("protocol-unsupported");
    }
  });
  test("global ranges and local page coverage must match exactly", () => {
    for (const patch of [
      { startPosition: "81" },
      { endPosition: "83" },
      { startPositionId: 82 },
      { endPositionId: 84 },
      { pageIndex: 82 },
      { width: 619 },
      { children: [] },
    ]) {
      expect(() =>
        parseRenderedPage(
          pageWith((page) => Object.assign(page, patch)),
          context,
        ),
      ).toThrow("page-coverage-invalid");
    }
    expect(() =>
      parseRenderedPage(
        pageWith((page) => {
          if (Array.isArray(page.children))
            page.children.push(page.children[0]);
        }),
        context,
      ),
    ).toThrow("page-coverage-invalid");
    expect(() =>
      parseRenderedPage(
        imageWith((image) => {
          image.imageReference = "img_1.png";
        }),
        context,
      ),
    ).toThrow("page-coverage-invalid");
    expect(() =>
      parseRenderedPage(
        tar(withPax(members.filter((member) => member.name !== "img_0.png"))),
        context,
      ),
    ).toThrow("page-coverage-invalid");
    expect(() =>
      parseRenderedPage(
        tar(
          withPax([...members, { name: "img_1.png", bytes: Buffer.alloc(0) }]),
        ),
        context,
      ),
    ).toThrow("page-coverage-invalid");
  });
  test("source export rejects cropping, rotation, unequal scaling, and off-center images", () => {
    const unsupported = [
      imageWith((image) => {
        image.rect = { top: 0, left: 1, bottom: 2480, right: 1860 };
      }),
      imageWith((image) => {
        image.transform = [1 / 3, 1, 0, 1 / 3, 0, 25.1666667];
      }),
      imageWith((image) => {
        image.transform = [1 / 4, 0, 0, 1 / 3, 0, 25.1666667];
      }),
      imageWith((image) => {
        image.transform = [1 / 3, 0, 0, 1 / 3, 5, 25.1666667];
      }),
    ];
    for (const archive of unsupported)
      expect(() => parseRenderedPage(archive, context)).toThrow(
        "image-geometry-unsupported",
      );
  });
});

describe("timestamp-only PAX framing", () => {
  const file = { name: "example.json", bytes: Buffer.from("{}") };
  test("timestamp headers are consumed without changing member names or bytes", () => {
    expect(readTar(tar(withPax([file])))).toEqual([file]);
  });
  test("PAX overrides, malformed lengths, and dangling headers are refused", () => {
    const prefix = { name: "./PaxHeaders.X/example.json", type: "x" };
    const override = paxPayload([
      ["atime", "1"],
      ["ctime", "1"],
      ["mtime", "1"],
      ["path", "elsewhere"],
    ]);
    expect(() => readTar(tar([{ ...prefix, bytes: override }, file]))).toThrow(
      "protocol-unsupported",
    );
    expect(() =>
      readTar(tar([{ ...prefix, bytes: Buffer.from("99 atime=1\n") }, file])),
    ).toThrow("archive-invalid");
    const invalidPrefix = paxPayload([
      ["atime", "1"],
      ["ctime", "1"],
      ["mtime", "1"],
      ["LIBARCHIVE.creationtime", "1"],
    ]);
    invalidPrefix[0] = (invalidPrefix[0] ?? 0) | 128;
    expect(() =>
      readTar(tar([{ ...prefix, bytes: invalidPrefix }, file])),
    ).toThrow("archive-invalid");
    expect(() => readTar(tar(withPax([file]).slice(0, 1)))).toThrow(
      "archive-invalid",
    );
    const [header] = withPax([file]);
    if (!header) throw new Error("fixture header");
    expect(() =>
      readTar(tar([header, { name: "different.json", bytes: file.bytes }])),
    ).toThrow("archive-invalid");
  });
  test("the header bound counts PAX headers as well as regular members", () => {
    expect(() =>
      readTar(
        tar(
          withPax(
            Array.from({ length: 65 }, (_, index) => ({
              name: `entry-${index}.json`,
              bytes: Buffer.alloc(0),
            })),
          ),
        ),
      ),
    ).toThrow("archive-too-many-members");
  });
});
