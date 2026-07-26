import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateRawFixture
} from "../../event-log-benchmark/src/core.mjs";

const fixtureUrl = new URL("../v1/canonical-strokes.json", import.meta.url);
const manifestUrl = new URL("../v1/manifest.json", import.meta.url);

test("canonical renderer fixture is valid and matches its manifest", async () => {
  const [fixture, manifest] = await Promise.all([
    readFile(fixtureUrl, "utf8").then(JSON.parse),
    readFile(manifestUrl, "utf8").then(JSON.parse)
  ]);

  assert.deepEqual(validateRawFixture(fixture), []);
  assert.deepEqual(fixture.canvas, {
    width: manifest.canvas.width,
    height: manifest.canvas.height
  });

  const caseIds = fixture.strokes.map((stroke) => stroke.caseId);
  assert.deepEqual(caseIds, manifest.cases);
  assert.equal(new Set(caseIds).size, caseIds.length);
  assert.equal(
    fixture.strokes.filter((stroke) => stroke.cancelled).length,
    1
  );
});

