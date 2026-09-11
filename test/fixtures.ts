import { PNG } from "pngjs";
export function png(seed = 0): Buffer {
  const image = new PNG({ width: 1860, height: 2480 });
  image.data.fill(255);
  image.data[0] = seed;
  return PNG.sync.write(image, { colorType: 2, bitDepth: 8 });
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
export function renderMembers(
  page: number,
  seed = 0,
  notebookId = "synthetic-id",
) {
  const width = 1860,
    height = 2480,
    canvasWidth = 620,
    canvasHeight = 877;
  const scale = Math.min(canvasWidth / width, canvasHeight / height);
  const pageData = [
    {
      type: "page",
      pageIndex: 0,
      sectionId: 0,
      width: canvasWidth,
      height: canvasHeight,
      startPosition: String(page),
      endPosition: String(page),
      startPositionId: page + 1,
      endPositionId: page + 1,
      children: [
        {
          type: "image",
          imageReference: "img_0.png",
          rect: { top: 0, left: 0, bottom: height, right: width },
          transform: [
            Math.fround(scale),
            0,
            0,
            Math.fround(scale),
            Math.fround((canvasWidth - width * scale) / 2),
            Math.fround((canvasHeight - height * scale) / 2),
          ],
        },
      ],
    },
  ];
  const json = (name: string, value: unknown) => ({
    name,
    bytes: Buffer.from(JSON.stringify(value)),
  });
  return [
    json("glyphs.json", []),
    json(`page_data_${page}_${page}.json`, pageData),
    json("manifest.json", {
      manifestComplete: true,
      asin: notebookId,
      contentType: "notebook",
      bookFormat: "KDF",
      bookType: "FixedFormat",
      revision: "",
      acr: "",
    }),
    json("Metadata.json", {
      pages: { "0.png": { noteIndex: 0, noteId: "synthetic-shared-note" } },
    }),
    { name: "img_0.png", bytes: png(seed) },
    json(`tokens_${page}_${page}.json`, [{ pageIndex: 0, children: [] }]),
    json("toc.json", []),
    json("location_map.json", {}),
    json(`layout_data_${page}_${page}.json`, [
      { type: "page", pageIndex: 0, children: [] },
    ]),
    json("metadata.json", {}),
  ];
}
export function paxPayload(fields: [string, string][]): Buffer {
  return Buffer.from(
    fields
      .map(([key, value]) => {
        const record = ` ${key}=${value}\n`;
        let length = record.length + 1;
        while (String(length).length + record.length !== length)
          length = String(length).length + record.length;
        return String(length) + record;
      })
      .join(""),
  );
}
export function withPax(members: { name: string; bytes: Buffer }[]) {
  const timestamps = paxPayload(
    ["atime", "ctime", "mtime", "LIBARCHIVE.creationtime"].map((key) => [
      key,
      "1.000000000",
    ]),
  );
  return members.flatMap((member) => [
    { name: "./PaxHeaders.X/" + member.name, type: "x", bytes: timestamps },
    member,
  ]);
}
export function pageArchive(page: number, seed = 0): Buffer {
  return tar(withPax(renderMembers(page, seed)));
}
