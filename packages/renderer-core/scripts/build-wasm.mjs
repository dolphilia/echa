import { mkdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const source = fileURLToPath(
  new URL("../target/wasm32-unknown-unknown/release/koge_renderer.wasm", import.meta.url)
);
const destination = fileURLToPath(new URL("../dist/koge-renderer.wasm", import.meta.url));

await new Promise((resolve, reject) => {
  const child = spawn(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown"],
    { cwd: packageRoot, stdio: "inherit" }
  );
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`cargo build exited with ${code}`));
  });
});
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);

