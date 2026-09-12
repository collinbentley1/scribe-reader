import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProduct } from "../src/product.js";
import { productFixture } from "./product-fixture.js";
import { parseWatchCommand } from "../src/watch-cli.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

test("product paths stay inside one bundle and its metadata matches its release", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe product & paths "));
  temporary.push(root);
  const product = await productFixture(root);
  expect(await readProduct(product.app)).toEqual(product);
  const info = join(product.app, "Contents", "Info.plist"),
    bytes = await readFile(info, "utf8");
  await writeFile(
    info,
    bytes.replace("com.cdbentley.scribe-reader", "com.example.foreign"),
  );
  await expect(readProduct(product.app)).rejects.toThrow(
    "product-info-mismatch",
  );
  await writeFile(info, bytes);
  const outside = join(root, "outside");
  await writeFile(outside, "");
  await rm(product.reader);
  await symlink(outside, product.reader);
  await expect(readProduct(product.app)).rejects.toThrow(
    "product-path-outside-bundle",
  );
});

test("one product command parses reader arguments without a second runtime CLI", () => {
  expect(
    parseWatchCommand([
      "reader",
      "--config",
      "/synthetic/config.json",
      "--",
      "sync",
      "synthetic",
      "--full",
    ]),
  ).toEqual({
    kind: "reader",
    configPath: "/synthetic/config.json",
    command: { kind: "sync", notebookId: "synthetic", full: true },
  });
  expect(() =>
    parseWatchCommand([
      "reader",
      "--config",
      "/synthetic/config.json",
      "--",
      "invalid",
    ]),
  ).toThrow("invalid-arguments");
});
