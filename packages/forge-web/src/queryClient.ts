import { QueryClient } from "@tanstack/react-query";

function statusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      refetchOnWindowFocus: true,
      retry(failureCount, error) {
        const status = statusOf(error);
        if (status != null && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
