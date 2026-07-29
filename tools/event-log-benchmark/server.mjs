#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const port = Number.parseInt(process.env.ECHA_BENCHMARK_PORT ?? "4173", 10);
const host = process.env.ECHA_BENCHMARK_HOST ?? "127.0.0.1";
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"]
]);

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath = requestedPath === "/"
    ? "tools/event-log-benchmark/web/index.html"
    : requestedPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(repositoryRoot, relativePath);
  if (
    resolvedPath !== repositoryRoot
    && !resolvedPath.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedPath;
}

const server = http.createServer(async (request, response) => {
  try {
    let filePath = resolveRequestPath(request.url ?? "/");
    if (!filePath) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) throw new Error("Not a file");

    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `echa benchmark server: http://${host}:${port}/tools/event-log-benchmark/web/\n`
    + `drawing recorder: http://${host}:${port}/prototypes/v2/drawing-room/?measure=1\n`
  );
});
