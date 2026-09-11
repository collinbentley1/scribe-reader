import { PNG } from "pngjs";
export function png(seed = 0): Buffer {
  const image = new PNG({ width: 620, height: 877 });
  image.data.fill(255);
  image.data[0] = seed;
  return PNG.sync.write(image, { colorType: 6, bitDepth: 8 });
}
export function tar(
  members: { name: string; bytes: Buffer; type?: string }[],
  format = "ustar\0" + "00",
): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100, "ascii");
    header.write("0000600\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(
      member.bytes.length.toString(8).padStart(11, "0") + "\0",
      124,
      "ascii",
    );
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write(member.type ?? "0", 156, "ascii");
    header.write(format, 257, "ascii");
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(
      header,
      member.bytes,
      Buffer.alloc((512 - (member.bytes.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
export function pageArchive(page: number, seed = 0): Buffer {
  return tar([{ name: `page-${page}.png`, bytes: png(seed) }]);
}
