import { readTar, validatePng } from "./archive.js";
import { LIMITS, ReaderError, record, SETTINGS } from "./domain.js";

export const PROTOCOL = {
  version: "kdf-single-page-v1",
  verified: true,
  indexOrigin: 0,
  endBound: "inclusive",
  framing: "ustar-kdf-full-image-png",
};
export function isSourceImageMember(name: string): boolean {
  return name === "img_0.png";
}
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ReaderError("protocol-unsupported");
  }
}
export function parseRenderedPage(
  archive: Buffer,
  { notebookId, page }: { notebookId: string; page: number },
) {
  const members = readTar(archive);
  const pageDataName = `page_data_${page}_${page}.json`;
  const expected = new Set([
    pageDataName,
    `tokens_${page}_${page}.json`,
    `layout_data_${page}_${page}.json`,
    "img_0.png",
    "manifest.json",
    "Metadata.json",
    "metadata.json",
    "toc.json",
    "location_map.json",
    "glyphs.json",
  ]);
  if (members.length !== expected.size)
    throw new ReaderError("page-coverage-invalid");
  for (const member of members) {
    if (!expected.delete(member.name))
      throw new ReaderError("page-coverage-invalid");
    if (member.name.endsWith(".json") && member.bytes.length > LIMITS.json)
      throw new ReaderError("response-too-large");
  }
  const manifestMember = members.find(
    (member) => member.name === "manifest.json",
  );
  const pageMember = members.find((member) => member.name === pageDataName);
  const image = members.find((member) => isSourceImageMember(member.name));
  if (!manifestMember || !pageMember || !image)
    throw new ReaderError("page-coverage-invalid");
  const manifest = record(parseJson(manifestMember.bytes));
  if (
    manifest.manifestComplete !== true ||
    manifest.asin !== notebookId ||
    manifest.contentType !== "notebook" ||
    manifest.bookFormat !== "KDF" ||
    manifest.bookType !== "FixedFormat"
  )
    throw new ReaderError("protocol-unsupported");
  const pages = parseJson(pageMember.bytes);
  if (!Array.isArray(pages) || pages.length !== 1)
    throw new ReaderError("page-coverage-invalid");
  const rendered = record(pages[0]);
  if (
    rendered.type !== "page" ||
    rendered.pageIndex !== 0 ||
    rendered.sectionId !== 0 ||
    rendered.width !== SETTINGS.width ||
    rendered.height !== SETTINGS.height ||
    rendered.startPosition !== String(page) ||
    rendered.endPosition !== String(page) ||
    rendered.startPositionId !== page + 1 ||
    rendered.endPositionId !== page + 1 ||
    !Array.isArray(rendered.children) ||
    rendered.children.length !== 1
  )
    throw new ReaderError("page-coverage-invalid");
  const child = record(rendered.children[0]);
  if (child.type !== "image" || child.imageReference !== image.name)
    throw new ReaderError("page-coverage-invalid");
  const dimensions = validatePng(image.bytes);
  const rect = record(child.rect);
  if (
    rect.top !== 0 ||
    rect.left !== 0 ||
    rect.right !== dimensions.width ||
    rect.bottom !== dimensions.height
  )
    throw new ReaderError("image-geometry-unsupported");
  const transform = child.transform;
  if (
    !Array.isArray(transform) ||
    transform.length !== 6 ||
    !transform.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    throw new ReaderError("image-geometry-unsupported");
  const [scaleX, rotateY, rotateX, scaleY, left, top] = transform as number[];
  if (
    scaleX === undefined ||
    scaleY === undefined ||
    left === undefined ||
    top === undefined
  )
    throw new ReaderError("image-geometry-unsupported");
  const scale = Math.min(
    SETTINGS.width / dimensions.width,
    SETTINGS.height / dimensions.height,
  );
  const expectedLeft = (SETTINGS.width - dimensions.width * scale) / 2;
  const expectedTop = (SETTINGS.height - dimensions.height * scale) / 2;
  // KDF transforms use rounded floats. Compare in canvas pixels to bound the tolerated error.
  const tolerance = 0.001;
  if (
    rotateX !== 0 ||
    rotateY !== 0 ||
    scaleX <= 0 ||
    scaleY <= 0 ||
    Math.abs((scaleX - scale) * dimensions.width) > tolerance ||
    Math.abs((scaleY - scale) * dimensions.height) > tolerance ||
    Math.abs(left - expectedLeft) > tolerance ||
    Math.abs(top - expectedTop) > tolerance
  )
    throw new ReaderError("image-geometry-unsupported");
  return { ...image, ...dimensions };
}
