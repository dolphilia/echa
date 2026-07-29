#!/usr/bin/env node

import { chmod, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultEndpoint = "http://127.0.0.1:8792";

function usage() {
  throw new TypeError(
    "usage: cli.mjs scan | plan --out <private-plan.json> "
      + "| apply --plan <private-plan.json> --confirm <confirmation>",
  );
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) usage();
  return process.argv[index + 1];
}

function endpoint() {
  const value = process.env.KOGE_ORPHAN_OPERATOR_ENDPOINT ?? defaultEndpoint;
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new TypeError("operator endpoint must be localhost HTTP");
  }
  return url.origin;
}

async function post(path, body) {
  const response = await fetch(`${endpoint()}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`operator failed (${response.status}): ${JSON.stringify(result)}`);
  }
  return result;
}

async function createPlan() {
  const outputPath = resolve(option("--out"));
  const plan = await post("/plan");
  const file = await open(outputPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  } finally {
    await file.close();
  }
  await chmod(outputPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: "planned",
    output: outputPath,
    environment: plan.environment,
    sourceScanId: plan.sourceScanId,
    objectCount: plan.objectCount,
    objectBytes: plan.objectBytes,
    expiresAt: plan.expiresAt,
    planHash: plan.planHash,
    confirmation: plan.confirmation,
  }, null, 2)}\n`);
}

async function scan() {
  const result = await post("/scan");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function applyPlan() {
  const inputPath = resolve(option("--plan"));
  const confirmation = option("--confirm");
  const plan = JSON.parse(await readFile(inputPath, "utf8"));
  if (confirmation !== plan.confirmation) {
    throw new TypeError("confirmation does not match the plan file");
  }
  const result = await post("/apply", { plan, confirmation });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const command = process.argv[2];
if (command === "scan") {
  await scan();
} else if (command === "plan") {
  await createPlan();
} else if (command === "apply") {
  await applyPlan();
} else {
  usage();
}
