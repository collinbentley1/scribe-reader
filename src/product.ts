import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ReaderError, record, string } from "./domain.js";

export const PRODUCT = {
  name: "Scribe Reader",
  id: "com.cdbentley.scribe-reader",
  readerName: "Scribe Reader Capture",
  readerId: "com.cdbentley.scribe-reader.capture",
  bunVersion: "1.4.2",
  transport: "native-webkit-v1",
  minimumMacOS: "14.0",
} as const;

export type ProductBuild = Readonly<{
  schemaVersion: 1;
  productId: typeof PRODUCT.id;
  readerId: typeof PRODUCT.readerId;
  version: string;
  build: string;
  sourceRevision: string;
  sourceDigest: string;
  sourceDirty: boolean;
  bunVersion: typeof PRODUCT.bunVersion;
  transport: typeof PRODUCT.transport;
  swiftVersion: string;
  sdkVersion: string;
}>;

export type Product = Readonly<{
  app: string;
  watcher: string;
  reader: string;
  skill: string;
  release: ProductBuild;
}>;

export function productPlist(release: ProductBuild): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleIdentifier</key><string>${PRODUCT.id}</string>
<key>CFBundleName</key><string>${PRODUCT.name}</string>
<key>CFBundleDisplayName</key><string>${PRODUCT.name}</string>
<key>CFBundleExecutable</key><string>${PRODUCT.name}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${release.version}</string>
<key>CFBundleVersion</key><string>${release.build}</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`;
}

export function readerPlist(release: ProductBuild): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${PRODUCT.readerId}</string>
<key>CFBundleName</key><string>${PRODUCT.readerName}</string>
<key>CFBundleDisplayName</key><string>${PRODUCT.readerName}</string>
<key>CFBundleExecutable</key><string>${PRODUCT.readerName}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${release.version}</string>
<key>CFBundleVersion</key><string>${release.build}</string>
<key>LSMinimumSystemVersion</key><string>${PRODUCT.minimumMacOS}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;
}

export function parseProductBuild(value: unknown): ProductBuild {
  const raw = record(value);
  if (
    raw.schemaVersion !== 1 ||
    raw.productId !== PRODUCT.id ||
    raw.readerId !== PRODUCT.readerId ||
    raw.bunVersion !== PRODUCT.bunVersion ||
    raw.transport !== PRODUCT.transport
  )
    throw new ReaderError("product-build-invalid");
  const version = string(raw.version),
    build = string(raw.build),
    sourceRevision = string(raw.sourceRevision),
    sourceDigest = string(raw.sourceDigest);
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !/^[1-9]\d*$/.test(build) ||
    !/^[a-f0-9]{40}$/.test(sourceRevision) ||
    !/^[a-f0-9]{64}$/.test(sourceDigest) ||
    typeof raw.sourceDirty !== "boolean"
  )
    throw new ReaderError("product-build-invalid");
  return {
    schemaVersion: 1,
    productId: PRODUCT.id,
    readerId: PRODUCT.readerId,
    version,
    build,
    sourceRevision,
    sourceDigest,
    sourceDirty: raw.sourceDirty,
    bunVersion: PRODUCT.bunVersion,
    transport: PRODUCT.transport,
    swiftVersion: string(raw.swiftVersion, 1024),
    sdkVersion: string(raw.sdkVersion, 32),
  };
}

export async function readProduct(appPath: string): Promise<Product> {
  if (!isAbsolute(appPath) || /[\x00-\x1f\x7f]/.test(appPath))
    throw new ReaderError("absolute-path-required");
  const app = await realpath(resolve(appPath));
  async function inside(relative: string, mode: number): Promise<string> {
    const path = await realpath(join(app, relative));
    if (!path.startsWith(app + "/"))
      throw new ReaderError("product-path-outside-bundle");
    await access(path, mode);
    return path;
  }
  async function text(relative: string): Promise<string> {
    const path = await inside(relative, constants.R_OK);
    if ((await stat(path)).size > 16_384)
      throw new ReaderError("product-build-invalid");
    return readFile(path, "utf8");
  }
  const release = parseProductBuild(
    JSON.parse(await text("Contents/Resources/build.json")) as unknown,
  );
  if ((await text("Contents/Info.plist")) !== productPlist(release))
    throw new ReaderError("product-info-mismatch");
  const watcher = await inside(
      `Contents/MacOS/${PRODUCT.name}`,
      constants.X_OK,
    ),
    reader = await inside(
      `Contents/Helpers/${PRODUCT.readerName}.app/Contents/MacOS/${PRODUCT.readerName}`,
      constants.X_OK,
    ),
    skill = await inside(
      "Contents/Resources/skills/scribe-prep",
      constants.R_OK,
    );
  await inside(
    "Contents/Resources/skills/scribe-prep/SKILL.md",
    constants.R_OK,
  );
  return { app, watcher, reader, skill, release };
}
