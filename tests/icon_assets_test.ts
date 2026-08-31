import { assert, assertEquals } from "@std/assert";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

type RgbaImage = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

Deno.test("macOS icon uses standard ICNS slots and optical padding", async () => {
  const sourceSvg = await Deno.readTextFile(
    new URL("../assets/icon-macos.svg", import.meta.url),
  );
  assert(
    sourceSvg.includes('<image href="icon.svg" x="100" y="100" width="824" height="824" />'),
  );

  const sourcePng = await Deno.readFile(new URL("../assets/icon-macos.png", import.meta.url));
  const sourceImage = await decodeRgbaPng(sourcePng);
  assertEquals([sourceImage.width, sourceImage.height], [1024, 1024]);
  assertEquals(findAlphaBounds(sourceImage), [100, 100, 924, 924]);

  const icon = await Deno.readFile(new URL("../assets/icon.icns", import.meta.url));
  assertEquals(text(icon, 0, 4), "icns");
  assertEquals(uint32(icon, 4), icon.length);

  const entries: Array<{ type: string; size: number; alphaBounds: number[] }> = [];
  let offset = 8;
  while (offset < icon.length) {
    const length = uint32(icon, offset + 4);
    assert(length >= 8 && offset + length <= icon.length);
    const png = icon.subarray(offset + 8, offset + length);
    assertEquals([...png.subarray(0, PNG_SIGNATURE.length)], PNG_SIGNATURE);

    const image = await decodeRgbaPng(png);
    assertEquals(image.width, image.height);
    const type = text(icon, offset, 4);
    if (type === "ic10") assertEquals(png, sourcePng);
    entries.push({
      type,
      size: image.width,
      alphaBounds: findAlphaBounds(image),
    });
    offset += length;
  }

  assertEquals(offset, icon.length);
  assertEquals(entries, [
    { type: "icp4", size: 16, alphaBounds: [2, 2, 14, 14] },
    { type: "ic11", size: 32, alphaBounds: [3, 3, 29, 29] },
    { type: "icp5", size: 32, alphaBounds: [3, 3, 29, 29] },
    { type: "ic12", size: 64, alphaBounds: [6, 6, 58, 58] },
    { type: "ic07", size: 128, alphaBounds: [13, 13, 116, 116] },
    { type: "ic13", size: 256, alphaBounds: [25, 25, 231, 231] },
    { type: "ic08", size: 256, alphaBounds: [25, 25, 231, 231] },
    { type: "ic14", size: 512, alphaBounds: [50, 50, 462, 462] },
    { type: "ic09", size: 512, alphaBounds: [50, 50, 462, 462] },
    { type: "ic10", size: 1024, alphaBounds: [100, 100, 924, 924] },
  ]);
});

async function decodeRgbaPng(png: Uint8Array): Promise<RgbaImage> {
  let width = 0;
  let height = 0;
  const idatChunks: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.length;

  while (offset < png.length) {
    const length = uint32(png, offset);
    const type = text(png, offset + 4, 4);
    const dataOffset = offset + 8;
    assert(dataOffset + length + 4 <= png.length);

    if (type === "IHDR") {
      width = uint32(png, dataOffset);
      height = uint32(png, dataOffset + 4);
      assertEquals(
        [...png.subarray(dataOffset + 8, dataOffset + 13)],
        [8, 6, 0, 0, 0],
      );
    } else if (type === "IDAT") {
      idatChunks.push(png.subarray(dataOffset, dataOffset + length));
    }

    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }

  assert(width > 0 && height > 0 && idatChunks.length > 0);
  const compressed = concat(idatChunks);
  const decompressor = new DecompressionStream("deflate");
  const output = new Response(decompressor.readable).arrayBuffer();
  const writer = decompressor.writable.getWriter();
  await writer.write(compressed);
  await writer.close();

  return {
    width,
    height,
    pixels: unfilterRgba(new Uint8Array(await output), width, height),
  };
}

function unfilterRgba(raw: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  assertEquals(raw.length, height * (stride + 1));

  const pixels = new Uint8Array(height * stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inputOffset++];
    assert(filter <= 4);
    const rowOffset = y * stride;

    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[rowOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset - stride + x - bytesPerPixel]
        : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
        ? up
        : filter === 3
        ? Math.floor((left + up) / 2)
        : filter === 4
        ? paeth(left, up, upLeft)
        : 0;
      pixels[rowOffset + x] = (raw[inputOffset++] + predictor) & 0xff;
    }
  }

  return pixels;
}

function findAlphaBounds(image: RgbaImage): number[] {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  assert(maxX >= minX && maxY >= minY);
  return [minX, minY, maxX + 1, maxY + 1];
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result: Uint8Array<ArrayBuffer> = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(offset, offset + length));
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}
