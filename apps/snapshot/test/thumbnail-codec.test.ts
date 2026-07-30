import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  createRoomThumbnail,
  encodePngRgba,
  resizeRgbaBilinear,
} from "../src/thumbnail-codec";
import { describe, expect, it } from "vitest";

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset);
}

describe("thumbnail codec", () => {
  it("resizes RGBA deterministically with bilinear sampling", () => {
    const source = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
    expect([...resizeRgbaBilinear(source, 2, 2, 1, 1)])
      .toEqual([128, 128, 128, 255]);
  });

  it("encodes an RGBA PNG with the requested dimensions", async () => {
    const png = await encodePngRgba(
      new Uint8Array([12, 34, 56, 255]),
      1,
      1,
    );
    expect([...png.subarray(0, 8)]).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect(uint32(png, 16)).toBe(1);
    expect(uint32(png, 20)).toBe(1);
  });

  it("creates the fixed square room thumbnail", async () => {
    const source = new Uint8Array(10 * 10 * 4).fill(255);
    const png = await createRoomThumbnail(source, 10, 10);
    expect(uint32(png, 16)).toBe(THUMBNAIL_WIDTH);
    expect(uint32(png, 20)).toBe(THUMBNAIL_HEIGHT);
  });
});
