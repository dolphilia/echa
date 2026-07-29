import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import type { CodecCandidateName } from "../src";

const output = process.argv[2];
const codecs: CodecCandidateName[] = ["json", "messagepack", "cbor"];
const results = await Promise.all(codecs.map(async (codec) => {
  const buildResult = await build({
    entryPoints: [new URL(`./bundle-entries/${codec}.ts`, import.meta.url).pathname],
    bundle: true,
    format: "esm",
    minify: true,
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    write: false,
  });
  const bytes = buildResult.outputFiles[0]?.contents;
  if (!bytes) throw new Error(`No bundle output for ${codec}`);
  return {
    codec,
    minifiedBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
  };
}));

const report = {
  schema: "koge.codec-bundle-benchmark.v1",
  recordedAt: new Date().toISOString(),
  target: "browser-es2022",
  exports: ["encode", "decode"],
  results,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized);
process.stdout.write(serialized);
