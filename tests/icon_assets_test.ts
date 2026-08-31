import { assert, assertEquals } from "@std/assert";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

Deno.test("macOS icon uses the standard ICNS size and Retina slots", async () => {
  const icon = await Deno.readFile(new URL("../assets/icon.icns", import.meta.url));
  assertEquals(text(icon, 0, 4), "icns");
  assertEquals(uint32(icon, 4), icon.length);

  const entries: Array<{ type: string; size: number }> = [];
  let offset = 8;
  while (offset < icon.length) {
    const length = uint32(icon, offset + 4);
    assert(length >= 8 && offset + length <= icon.length);
    const png = icon.subarray(offset + 8, offset + length);
    assertEquals([...png.subarray(0, PNG_SIGNATURE.length)], PNG_SIGNATURE);
    assertEquals(uint32(png, 16), uint32(png, 20));
    entries.push({ type: text(icon, offset, 4), size: uint32(png, 16) });
    offset += length;
  }

  assertEquals(offset, icon.length);
  assertEquals(entries, [
    { type: "icp4", size: 16 },
    { type: "ic11", size: 32 },
    { type: "icp5", size: 32 },
    { type: "ic12", size: 64 },
    { type: "ic07", size: 128 },
    { type: "ic13", size: 256 },
    { type: "ic08", size: 256 },
    { type: "ic14", size: 512 },
    { type: "ic09", size: 512 },
    { type: "ic10", size: 1024 },
  ]);
});

function text(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(offset, offset + length));
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}
