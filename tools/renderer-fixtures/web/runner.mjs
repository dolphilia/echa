import {
  instantiateRenderer,
  renderFixture
} from "/packages/renderer-core/js/index.mjs";

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0")
  ).join("");
}

try {
  const [wasm, fixture, manifest] = await Promise.all([
    fetch("/packages/renderer-core/dist/koge-renderer.wasm").then((response) =>
      response.arrayBuffer()
    ),
    fetch("/tools/renderer-fixtures/v1/canonical-strokes.json").then((response) =>
      response.json()
    ),
    fetch("/tools/renderer-fixtures/v1/manifest.json").then((response) =>
      response.json()
    )
  ]);
  const startedAt = performance.now();
  const renderer = await instantiateRenderer(wasm);
  const rgba = renderFixture(renderer, fixture);
  const result = {
    ok: false,
    rendererVersion: renderer.exports.renderer_version(),
    rgbaBytes: rgba.byteLength,
    rgbaHash: await sha256(rgba),
    renderWallMs: performance.now() - startedAt
  };
  result.ok = (
    result.rendererVersion === manifest.rendererVersion
    && result.rgbaHash === manifest.rgbaHash
  );
  window.__kogeRendererResult = result;
  document.querySelector("#result").textContent = JSON.stringify(result);
} catch (error) {
  window.__kogeRendererError = error instanceof Error ? error.message : String(error);
  document.querySelector("#result").textContent = window.__kogeRendererError;
}

