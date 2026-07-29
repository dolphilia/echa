const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decode(value: Uint8Array): unknown {
  return JSON.parse(decoder.decode(value));
}
