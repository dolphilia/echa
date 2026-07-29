import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RendererSession,
  instantiateRenderer,
  renderFixture
} from "../js/index.mjs";

const wasmUrl = new URL("../dist/koge-renderer.wasm", import.meta.url);
const fixtureUrl = new URL("../../../tools/renderer-fixtures/v1/canonical-strokes.json", import.meta.url);
const manifestUrl = new URL("../../../tools/renderer-fixtures/v1/manifest.json", import.meta.url);

test("WASM renderer produces the canonical RGBA hash", async () => {
  const [wasm, fixture, manifest] = await Promise.all([
    readFile(wasmUrl),
    readFile(fixtureUrl, "utf8").then(JSON.parse),
    readFile(manifestUrl, "utf8").then(JSON.parse)
  ]);
  const renderer = await instantiateRenderer(wasm);
  const rgba = renderFixture(renderer, fixture);
  const hash = createHash("sha256").update(rgba).digest("hex");

  assert.equal(rgba.byteLength, fixture.canvas.width * fixture.canvas.height * 4);
  assert.equal(renderer.exports.renderer_version(), manifest.rendererVersion);
  assert.equal(hash, manifest.rgbaHash);
});

test("renderer sessions can resume from canonical RGBA pixels", async () => {
  const [wasm, fixture] = await Promise.all([
    readFile(wasmUrl),
    readFile(fixtureUrl, "utf8").then(JSON.parse)
  ]);
  const renderer = await instantiateRenderer(wasm);
  const expected = renderFixture(renderer, fixture);
  const session = new RendererSession(
    renderer,
    fixture.canvas.width,
    fixture.canvas.height
  );
  try {
    session.loadPixels(expected);
    assert.deepEqual(session.pixels(), expected);
    assert.throws(
      () => session.loadPixels(expected.subarray(1)),
      /do not match renderer canvas/
    );
  } finally {
    session.dispose();
  }
});
