const API_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new TypeError(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const account = values.get("account");
  const script = values.get("script");
  const from = values.get("from");
  const to = values.get("to");
  if (!account || !script || !from || !to) {
    throw new TypeError("--account, --script, --from and --to are required");
  }
  for (const [name, value] of [["from", from], ["to", to]]) {
    if (!Number.isFinite(Date.parse(value))) {
      throw new TypeError(`--${name} must be an ISO 8601 timestamp`);
    }
  }
  return { account, script, from, to };
}

const token = process.env.CLOUDFLARE_ANALYTICS_API_TOKEN;
if (!token) {
  throw new TypeError(
    "CLOUDFLARE_ANALYTICS_API_TOKEN is required and is never read from repository files",
  );
}

const options = parseArguments(process.argv.slice(2));
const query = `
  query WorkerMemory(
    $accountTag: string
    $datetimeStart: string
    $datetimeEnd: string
    $scriptName: string
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: {
            scriptName: $scriptName
            datetime_geq: $datetimeStart
            datetime_leq: $datetimeEnd
          }
        ) {
          sum {
            requests
            errors
          }
          quantiles {
            cpuTimeP50
            cpuTimeP99
            memoryUsageBytesP50
            memoryUsageBytesP90
            memoryUsageBytesP99
            memoryUsageBytesP999
          }
          dimensions {
            datetime
            scriptName
            status
          }
        }
      }
    }
  }
`;

const response = await fetch(API_ENDPOINT, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    query,
    variables: {
      accountTag: options.account,
      datetimeStart: new Date(options.from).toISOString(),
      datetimeEnd: new Date(options.to).toISOString(),
      scriptName: options.script,
    },
  }),
});
const body = await response.json();
if (!response.ok || body.errors?.length) {
  const messages = body.errors?.map((error) => error.message).join("; ");
  throw new Error(
    `Cloudflare Analytics query failed (${response.status}): ${messages ?? "unknown error"}`,
  );
}

const samples =
  body.data?.viewer?.accounts?.flatMap(
    (account) => account.workersInvocationsAdaptive ?? [],
  ) ?? [];
const memoryFields = [
  "memoryUsageBytesP50",
  "memoryUsageBytesP90",
  "memoryUsageBytesP99",
  "memoryUsageBytesP999",
];
const maximumMemoryBytes = Object.fromEntries(
  memoryFields.map((field) => [
    field,
    Math.max(0, ...samples.map((sample) => sample.quantiles?.[field] ?? 0)),
  ]),
);
const report = {
  schema: "koge.cloudflare-worker-metrics.v1",
  queriedAt: new Date().toISOString(),
  input: {
    account: options.account,
    script: options.script,
    from: new Date(options.from).toISOString(),
    to: new Date(options.to).toISOString(),
  },
  sampleCount: samples.length,
  maximumMemoryBytes,
  workerMemoryLimitBytes: 128 * 1024 * 1024,
  targetMaximumBytesForThirtyPercentHeadroom: Math.floor(
    128 * 1024 * 1024 * 0.7,
  ),
  samples,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
