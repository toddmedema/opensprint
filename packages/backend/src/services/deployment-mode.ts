import type { RuntimeDeploymentMode } from "@opensprint/shared";
export function getDeploymentMode(): RuntimeDeploymentMode {
  const mode = process.env.OPENSPRINT_DEPLOYMENT_MODE ?? "trusted-local";
  if (mode !== "trusted-local" && mode !== "shared-host" && mode !== "isolated-hosted")
    throw new Error("Invalid OPENSPRINT_DEPLOYMENT_MODE.");
  return mode;
}
export function validateDeploymentMode(): void {
  if (
    getDeploymentMode() !== "trusted-local" &&
    (!process.env.OPENSPRINT_HOST_TOKEN || process.env.OPENSPRINT_HOST_TOKEN.length < 32)
  ) {
    throw new Error(
      "Shared deployment requires OPENSPRINT_HOST_TOKEN with at least 32 characters; it is never embedded in browser HTML."
    );
  }
  if (getDeploymentMode() !== "trusted-local") {
    const origin = process.env.OPENSPRINT_PUBLIC_ORIGIN;
    if (!origin || new URL(origin).origin !== origin || !origin.startsWith("https://"))
      throw new Error(
        "Shared deployment requires an exact HTTPS OPENSPRINT_PUBLIC_ORIGIN behind a TLS proxy."
      );
  }
  const replicas = Number(process.env.OPENSPRINT_BACKEND_REPLICAS ?? "1");
  if (!Number.isInteger(replicas) || replicas < 1)
    throw new Error("Invalid OPENSPRINT_BACKEND_REPLICAS.");
}
