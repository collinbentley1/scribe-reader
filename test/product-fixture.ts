import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PRODUCT,
  productPlist,
  readProduct,
  type ProductBuild,
} from "../src/product.js";

export async function productFixture(root: string) {
  const app = join(root, "Applications", PRODUCT.name + ".app");
  const release: ProductBuild = {
    schemaVersion: 1,
    productId: PRODUCT.id,
    readerId: PRODUCT.readerId,
    version: "0.1.0",
    build: "1",
    sourceRevision: "0000000000000000000000000000000000000000",
    sourceDigest: "0".repeat(64),
    sourceDirty: false,
    bunVersion: PRODUCT.bunVersion,
    transport: PRODUCT.transport,
    swiftVersion: "Apple Swift version 6.4",
    sdkVersion: "27.0",
  };
  const files = new Map([
    ["Contents/Info.plist", productPlist(release)],
    ["Contents/Resources/build.json", JSON.stringify(release)],
    ["Contents/Resources/skills/scribe-prep/SKILL.md", "synthetic skill"],
    [`Contents/MacOS/${PRODUCT.name}`, ""],
    [
      `Contents/Helpers/${PRODUCT.readerName}.app/Contents/MacOS/${PRODUCT.readerName}`,
      "",
    ],
  ]);
  for (const [relative, bytes] of files) {
    const path = join(app, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    if (relative.includes("/MacOS/")) await chmod(path, 0o700);
  }
  return readProduct(app);
}
