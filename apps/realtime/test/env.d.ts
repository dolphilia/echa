import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

declare module "vitest" {
  export interface ProvidedContext {
    D1_MIGRATIONS: D1Migration[];
  }
}
