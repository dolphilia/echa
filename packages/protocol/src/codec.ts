import { decode as decodeMessagePack, encode as encodeMessagePack } from "@msgpack/msgpack";
import {
  PROTOCOL_LIMITS,
  type ClientStrokeEvent,
  type CodecName,
  type ValidationResult,
} from "./types";
import { validateClientEvent } from "./validation";
import { fromBinaryWireEvent, toBinaryWireEvent } from "./wire";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export class ProtocolDecodeError extends Error {
  readonly result: ValidationResult;

  constructor(message: string, result: ValidationResult) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.result = result;
  }
}

export function encodeEvent(event: ClientStrokeEvent, codec: CodecName): Uint8Array {
  const validation = validateClientEvent(event);
  if (!validation.success) {
    throw new ProtocolDecodeError("Cannot encode an invalid event", validation);
  }

  let encoded: Uint8Array;
  switch (codec) {
    case "json":
      encoded = textEncoder.encode(JSON.stringify(event));
      break;
    case "messagepack":
      encoded = encodeMessagePack(toBinaryWireEvent(event));
      break;
  }

  if (encoded.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return encoded;
}

export function decodeEvent(bytes: Uint8Array, codec: CodecName): ClientStrokeEvent {
  if (bytes.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }

  let decoded: unknown;
  try {
    switch (codec) {
      case "json":
        decoded = JSON.parse(textDecoder.decode(bytes));
        break;
      case "messagepack":
        decoded = fromBinaryWireEvent(decodeMessagePack(bytes));
        break;
    }
  } catch (error) {
    const result: ValidationResult = {
      success: false,
      issues: [{
        code: "INVALID_FIELD",
        path: "$",
        message: error instanceof Error ? error.message : "codec decode failed",
      }],
    };
    throw new ProtocolDecodeError("Could not decode protocol frame", result);
  }

  const result = validateClientEvent(decoded);
  if (!result.success) {
    throw new ProtocolDecodeError("Decoded frame is not a valid event", result);
  }
  return result.data;
}
