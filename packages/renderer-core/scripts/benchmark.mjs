import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";

import { instantiateRenderer, renderFixture } from "../js/index.mjs";

const iterations = Number.parseInt(process.argv[2] ?? "20", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000) {
  throw new RangeError("iterations must be an integer from 1 to 1000");
}

const [wasm, fixture] = await Promise.all([
  readFile(new URL("../dist/koge-renderer.wasm", import.meta.url)),
  readFile(
    new URL("../../../tools/renderer-fixtures/v1/canonical-strokes.json", import.meta.url),
    "utf8"
  ).then(JSON.parse)
]);
const renderer = await instantiateRenderer(wasm);
renderFixture(renderer, fixture);

const samples = [];
let lastRgba;
for (let index = 0; index < iterations; index += 1) {
  const startedAt = performance.now();
  lastRgba = renderFixture(renderer, fixture);
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);

function percentile(fraction) {
  return samples[Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil(samples.length * fraction) - 1)
  )];
}

process.stdout.write(`${JSON.stringify({
  schema: "koge.renderer-benchmark.v1",
  runtime: `Node ${process.version}`,
  rendererVersion: renderer.exports.renderer_version(),
  canvas: fixture.canvas,
  strokeCount: fixture.strokes.length,
  pointCount: fixture.strokes.reduce(
    (total, stroke) => total + stroke.points.length,
    0
  ),
  iterations,
  wasmBytes: wasm.byteLength,
  rgbaBytes: lastRgba.byteLength,
  rgbaHash: createHash("sha256").update(lastRgba).digest("hex"),
  renderWallMs: {
    minimum: samples[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    maximum: samples.at(-1),
    average: samples.reduce((total, value) => total + value, 0) / samples.length
  }
}, null, 2)}\n`);

