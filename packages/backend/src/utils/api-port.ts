import { DEFAULT_API_PORT } from "@opensprint/shared";

/** Resolve the host listener port consistently, including an empty environment value. */
export function getApiPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number.parseInt(environment.PORT || String(DEFAULT_API_PORT), 10);
}
