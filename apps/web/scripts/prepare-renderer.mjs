import { copyFile, mkdir } from "node:fs/promises";

const outputDirectory = new URL("../public/generated/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  new URL("../../../packages/renderer-core/dist/koge-renderer.wasm", import.meta.url),
  new URL("koge-renderer-v1.wasm", outputDirectory)
);
