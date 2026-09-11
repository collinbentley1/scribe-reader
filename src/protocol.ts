import { readTar, validatePng } from "./archive.js";
import { ReaderError, SETTINGS } from "./domain.js";

export const PROTOCOL = {
  version: "unverified-single-page-v0",
  verified: false,
  indexOrigin: 0,
  endBound: "inclusive",
  framing: "tar-plain-png",
};
export function matchesPageMember(name: string, page: number): boolean {
  const match = /^page-(0|[1-9][0-9]*)\.png$/.exec(name);
  return match !== null && Number(match[1]) === page;
}
export function parseRenderedPage(archive: Buffer, page: number) {
  const members = readTar(archive);
  if (members.length !== 1) throw new ReaderError("page-coverage-invalid");
  const member = members[0];
  if (!member) throw new ReaderError("page-coverage-invalid");
  if (!matchesPageMember(member.name, page))
    throw new ReaderError("protocol-unsupported");
  const dimensions = validatePng(member.bytes);
  if (
    dimensions.width !== SETTINGS.width ||
    dimensions.height !== SETTINGS.height
  )
    throw new ReaderError("image-dimensions-invalid");
  return { ...member, ...dimensions };
}
