export const THUMBNAIL_WIDTH = 512;
export const THUMBNAIL_HEIGHT = 512;
export const THUMBNAIL_CONTENT_TYPE = "image/png";
export const THUMBNAIL_EXTENSION = "png";

const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(type: Uint8Array, data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const bytes of [type, data]) {
    for (const byte of bytes) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength)
    .setUint32(offset, value);
}

function pngChunk(typeText: string, data: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(typeText);
  if (type.byteLength !== 4) throw new TypeError("PNG chunk type must be 4 bytes");
  const chunk = new Uint8Array(12 + data.byteLength);
  writeUint32(chunk, 0, data.byteLength);
  chunk.set(type, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.byteLength, crc32(type, data));
  return chunk;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function resizeRgbaBilinear(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = THUMBNAIL_WIDTH,
  targetHeight = THUMBNAIL_HEIGHT,
): Uint8Array {
  if (
    !Number.isSafeInteger(sourceWidth)
    || sourceWidth <= 0
    || !Number.isSafeInteger(sourceHeight)
    || sourceHeight <= 0
    || !Number.isSafeInteger(targetWidth)
    || targetWidth <= 0
    || !Number.isSafeInteger(targetHeight)
    || targetHeight <= 0
    || source.byteLength !== sourceWidth * sourceHeight * 4
  ) {
    throw new TypeError("invalid RGBA resize input");
  }

  const target = new Uint8Array(targetWidth * targetHeight * 4);
  const xScale = sourceWidth / targetWidth;
  const yScale = sourceHeight / targetHeight;
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = Math.max(
      0,
      Math.min(sourceHeight - 1, (targetY + 0.5) * yScale - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = Math.max(
        0,
        Math.min(sourceWidth - 1, (targetX + 0.5) * xScale - 0.5),
      );
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      const topLeft = (y0 * sourceWidth + x0) * 4;
      const topRight = (y0 * sourceWidth + x1) * 4;
      const bottomLeft = (y1 * sourceWidth + x0) * 4;
      const bottomRight = (y1 * sourceWidth + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source[topLeft + channel]!
          + (source[topRight + channel]! - source[topLeft + channel]!)
            * xWeight;
        const bottom = source[bottomLeft + channel]!
          + (source[bottomRight + channel]! - source[bottomLeft + channel]!)
            * xWeight;
        target[targetOffset + channel] = Math.round(
          top + (bottom - top) * yWeight,
        );
      }
    }
  }
  return target;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const compression = new CompressionStream("deflate");
  const writer = compression.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await new Response(compression.readable).arrayBuffer());
}

export async function encodePngRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(width)
    || width <= 0
    || !Number.isSafeInteger(height)
    || height <= 0
    || rgba.byteLength !== width * height * 4
  ) {
    throw new TypeError("invalid PNG RGBA input");
  }
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (1 + width * 4);
    scanlines[targetOffset] = 0;
    scanlines.set(
      rgba.subarray(row * width * 4, (row + 1) * width * 4),
      targetOffset + 1,
    );
  }
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concatenate([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflate(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

export async function createRoomThumbnail(
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Uint8Array> {
  const resized = resizeRgbaBilinear(
    sourceRgba,
    sourceWidth,
    sourceHeight,
  );
  return encodePngRgba(resized, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
}
