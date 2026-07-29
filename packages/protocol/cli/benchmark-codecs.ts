import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  decodeEvent,
  encodeEvent,
  fromBinaryWireEvent,
  rawFixtureToClientEvents,
  toBinaryWireEvent,
  validateClientEvent,
  type ClientStrokeEvent,
  type CodecCandidateName,
  type RawStrokeFixture,
} from "../src";

type CodecResult = {
  codec: CodecCandidateName;
  encodedBytes: number;
  averageEventBytes: number;
  largestEventBytes: number;
  encodeMilliseconds: number;
  decodeMilliseconds: number;
};

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const defaultInput = resolve(
  repositoryRoot,
  "tools/event-log-benchmark/fixtures/echa-raw-strokes-2026-07-26T16-06-54-108Z.json",
);
const input = resolve(process.argv[2] ?? defaultInput);
const output = process.argv[3] ? resolve(process.argv[3]) : undefined;
const iterations = 20;
const fixture = JSON.parse(await readFile(input, "utf8")) as RawStrokeFixture;
const events = rawFixtureToClientEvents(fixture);
const codecs: CodecCandidateName[] = ["json", "messagepack", "cbor"];
const results: CodecResult[] = [];

function encodeCandidate(event: ClientStrokeEvent, codec: CodecCandidateName): Uint8Array {
  return codec === "cbor"
    ? encodeCbor(toBinaryWireEvent(event))
    : encodeEvent(event, codec);
}

function decodeCandidate(frame: Uint8Array, codec: CodecCandidateName): ClientStrokeEvent {
  if (codec !== "cbor") return decodeEvent(frame, codec);
  const result = validateClientEvent(fromBinaryWireEvent(decodeCbor(frame)));
  if (!result.success) throw new Error("CBOR candidate failed protocol validation");
  return result.data;
}

for (const codec of codecs) {
  const encoded = events.map((event) => encodeCandidate(event, codec));
  const encodeStartedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    events.forEach((event) => encodeCandidate(event, codec));
  }
  const encodeMilliseconds = (performance.now() - encodeStartedAt) / iterations;

  const decodeStartedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    encoded.forEach((frame) => decodeCandidate(frame, codec));
  }
  const decodeMilliseconds = (performance.now() - decodeStartedAt) / iterations;
  const sizes = encoded.map((frame) => frame.byteLength);
  const encodedBytes = sizes.reduce((total, size) => total + size, 0);
  results.push({
    codec,
    encodedBytes,
    averageEventBytes: encodedBytes / events.length,
    largestEventBytes: Math.max(...sizes),
    encodeMilliseconds,
    decodeMilliseconds,
  });
}

const report = {
  schema: "koge.codec-benchmark.v1",
  recordedAt: new Date().toISOString(),
  input,
  iterations,
  eventCount: events.length,
  results,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized);
process.stdout.write(serialized);
