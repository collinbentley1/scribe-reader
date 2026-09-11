import { PNG } from "pngjs";
import { inflateSync } from "node:zlib";
import { LIMITS, ReaderError } from "./domain.js";

export type ArchiveMember = { name: string; bytes: Buffer };
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function octal(bytes: Buffer): number {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new ReaderError("archive-invalid");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new ReaderError("archive-invalid");
  return number;
}
function nameField(bytes: Buffer): string {
  const zero = bytes.indexOf(0);
  const value = bytes.subarray(0, zero < 0 ? bytes.length : zero);
  if ([...value].some((byte) => byte < 32 || byte > 126))
    throw new ReaderError("archive-invalid");
  return value.toString("ascii");
}
export function readTar(bytes: Buffer): ArchiveMember[] {
  if (
    bytes.length > LIMITS.archive ||
    bytes.length < 1024 ||
    bytes.length % 512 !== 0
  )
    throw new ReaderError("archive-invalid");
  const members: ArchiveMember[] = [],
    names = new Set<string>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > bytes.length ||
        !bytes.subarray(offset).every((byte) => byte === 0)
      )
        throw new ReaderError("archive-invalid");
      return members;
    }
    if (members.length >= LIMITS.members)
      throw new ReaderError("archive-too-many-members");
    let checksum = 0;
    for (let i = 0; i < 512; i++)
      checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    if (checksum !== octal(header.subarray(148, 156)))
      throw new ReaderError("archive-invalid");
    if (!header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00")))
      throw new ReaderError("protocol-unsupported");
    const type = header[156];
    if (type !== 0 && type !== 48)
      throw new ReaderError("protocol-unsupported");
    const base = nameField(header.subarray(0, 100)),
      prefix = nameField(header.subarray(345, 500));
    const name = prefix ? prefix + "/" + base : base;
    if (!name || name.length > 255 || names.has(name))
      throw new ReaderError("archive-invalid");
    names.add(name);
    const size = octal(header.subarray(124, 136));
    if (size > LIMITS.png) throw new ReaderError("image-too-large");
    const begin = offset + 512,
      end = begin + size,
      next = begin + Math.ceil(size / 512) * 512;
    if (
      next > bytes.length ||
      !bytes.subarray(end, next).every((byte) => byte === 0)
    )
      throw new ReaderError("archive-invalid");
    members.push({ name, bytes: bytes.subarray(begin, end) });
    offset = next;
  }
  throw new ReaderError("archive-invalid");
}
export function validatePng(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length > LIMITS.png ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(SIGNATURE)
  )
    throw new ReaderError("image-invalid");
  let offset = 8,
    width = 0,
    height = 0,
    rowBytes = 0,
    ended = false,
    dataEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new ReaderError("image-invalid");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new ReaderError("image-invalid");
    const payload = bytes.subarray(offset + 8, end - 4);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13)
        throw new ReaderError("image-invalid");
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (!width || !height || width * height > LIMITS.pixels)
        throw new ReaderError("image-too-large");
      const depth = payload[8],
        color = payload[9];
      const channels =
        color === 0 || color === 3
          ? 1
          : color === 2
            ? 3
            : color === 4
              ? 2
              : color === 6
                ? 4
                : 0;
      if (
        depth !== 8 ||
        !channels ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        throw new ReaderError("protocol-unsupported");
      rowBytes = width * channels + 1;
    } else if (type === "IHDR") throw new ReaderError("image-invalid");
    if (type === "IDAT") {
      if (dataEnded) throw new ReaderError("image-invalid");
      data.push(payload);
    } else if (data.length > 0) dataEnded = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !data.length)
        throw new ReaderError("image-invalid");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended) throw new ReaderError("image-invalid");
  try {
    const inflated = inflateSync(Buffer.concat(data), {
      maxOutputLength: rowBytes * height,
    });
    if (inflated.length !== rowBytes * height) throw new Error("length");
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      decoded.data.length !== width * height * 4
    )
      throw new Error("dimensions");
  } catch {
    throw new ReaderError("image-invalid");
  }
  return { width, height };
}
