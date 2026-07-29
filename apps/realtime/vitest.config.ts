import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations(
  new URL("../../migrations/d1", import.meta.url).pathname,
);

export default defineConfig({
  test: {
    provide: {
      D1_MIGRATIONS: d1Migrations,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
});
