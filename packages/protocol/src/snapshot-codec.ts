const HEADER_BYTES = 24;
const SNAPSHOT_MAGIC = [0x4b, 0x47, 0x53, 0x31] as const;
const SNAPSHOT_CODEC_VERSION = 1;

export type DecodedSnapshot = {
  readonly rendererVersion: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
};

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks are sequential.
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function encodeSnapshot(
  rgba: Uint8Array,
  width: number,
  height: number,
  rendererVersion: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || rgba.byteLength !== width * height * 4
  ) {
    throw new RangeError("invalid snapshot pixels");
  }
  const compressed = await readStream(
    new Blob([Uint8Array.from(rgba).buffer])
      .stream()
      .pipeThrough(new CompressionStream("deflate")),
  );
  const output = new Uint8Array(HEADER_BYTES + compressed.byteLength);
  output.set(SNAPSHOT_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, SNAPSHOT_CODEC_VERSION, true);
  view.setUint16(6, rendererVersion, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, rgba.byteLength, true);
  view.setUint32(20, compressed.byteLength, true);
  output.set(compressed, HEADER_BYTES);
  return output;
}

export async function decodeSnapshot(bytes: Uint8Array): Promise<DecodedSnapshot> {
  if (
    bytes.byteLength < HEADER_BYTES
    || SNAPSHOT_MAGIC.some((value, index) => bytes[index] !== value)
  ) {
    throw new TypeError("invalid snapshot header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codecVersion = view.getUint16(4, true);
  const rendererVersion = view.getUint16(6, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const rgbaLength = view.getUint32(16, true);
  const compressedLength = view.getUint32(20, true);
  if (
    codecVersion !== SNAPSHOT_CODEC_VERSION
    || width === 0
    || height === 0
    || rgbaLength !== width * height * 4
    || compressedLength !== bytes.byteLength - HEADER_BYTES
  ) {
    throw new RangeError("unsupported or inconsistent snapshot");
  }
  const rgba = await readStream(
    new Blob([Uint8Array.from(bytes.subarray(HEADER_BYTES)).buffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate")),
  );
  if (rgba.byteLength !== rgbaLength) {
    throw new RangeError("snapshot decompressed length mismatch");
  }
  return { rendererVersion, width, height, rgba };
}
