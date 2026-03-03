import type { QueryClient } from "@tanstack/react-query";

let queryClientInstance: QueryClient | null = null;

export function setQueryClient(client: QueryClient): void {
  queryClientInstance = client;
}

export function getQueryClient(): QueryClient {
  if (!queryClientInstance) {
    throw new Error(
      "QueryClient not set. Call setQueryClient() in main.tsx before using getQueryClient()."
    );
  }
  return queryClientInstance;
}
