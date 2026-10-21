import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProjectIdentity, ProjectPermission } from "@opensprint/shared";
import { identityService } from "../services/identity.service.js";
import { getLocalSessionToken } from "../services/local-session-auth.service.js";
import { runWithRequestContext } from "../services/request-context.js";
import { AppError } from "./error-handler.js";
import { getDeploymentMode } from "../services/deployment-mode.js";

export const SESSION_COOKIE = "opensprint_session";
export function requestAuthorization(req: Pick<Request, "headers">): string | undefined {
  if (req.headers.authorization) return req.headers.authorization;
  const raw = req.headers.cookie
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return raw && /^[a-zA-Z0-9_-]{32,4096}$/.test(raw) ? `Bearer ${raw}` : undefined;
}
export function csrfToken(principal: ProjectIdentity): string {
  return createHmac("sha256", getLocalSessionToken())
    .update(principal.credentialHash ?? "host")
    .digest("base64url");
}
export function assertCookieCsrf(req: Request, principal: ProjectIdentity): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.headers.authorization) return;
  const supplied = req.headers["x-opensprint-csrf"];
  const expected = csrfToken(principal);
  if (
    typeof supplied !== "string" ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    throw new AppError(403, "CSRF_REQUIRED", "Refresh your session before changing project data.");
  }
}
// Express routers are case-insensitive and accept a trailing slash by default.
// Authorization must classify every spelling that can reach the same handler.
function authorizationPath(path: string): string {
  return path.toLowerCase().replace(/\/+$/, "");
}
export function permissionForRequest(method: string, path: string): ProjectPermission {
  path = authorizationPath(path);
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return "read";
  if (method === "DELETE" && /^\/projects\/[^/]+\/tasks\/[^/]+$/.test(path)) return "control";
  if (/\/runtime\/presence$/.test(path)) return "read";
  if (/\/runtime\/presenter$/.test(path)) return "discuss";
  if (/\/runtime\/operations\/[^/]+\/(cancel|reconcile)$/.test(path)) return "read";
  if (/\/runtime\/attempts\/[^/]+\/stop$/.test(path)) return "control";
  if (/\/settings$|\/agents\/instructions(?:\/|$)/.test(path)) return "manage";
  if (/\/self-improvement(?:\/|$)/.test(path)) return "control";
  if (/\/publication\/approve(?:\/|$)|\/notifications\//.test(path)) return "approve";
  if (/\/publication\/publish(?:\/|$)/.test(path)) return "publish";
  if (/\/deliver(?:\/|$)/.test(path)) return "deploy";
  if (
    /\/(execute|execute-batch|re-execute|archive|mark-complete)(?:\/|$)|\/agents\/.*kill|\/(force-retry|unblock|mark-done|done)(?:\/|$)/.test(
      path
    )
  )
    return "control";
  if (/\/(commands|integrations|members|invitations)(?:\/|$)/.test(path)) return "manage";
  return "edit";
}
/** Shared APIs authorize every project path; host-only surfaces never inherit project credentials. */
export function redactNamedResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNamedResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["envVars", "expoToken", "apiKeys", "clientSecret"].includes(key))
      .map(([key, entry]) => [key, redactNamedResponse(entry)])
  );
}
export function projectAccess(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    if (!requestAuthorization(req))
      throw new AppError(
        403,
        "LOCAL_SESSION_AUTH_REQUIRED",
        "Sign in with an invitation or the host access token."
      );
    const policyPath = authorizationPath(req.path);
    const match = req.path.match(/^\/projects\/([^/]+)(?:\/|$)/i);
    const projectId = match
      ? decodeURIComponent(match[1])
      : policyPath === "/ws-upgrade-ticket" && typeof req.body?.projectId === "string"
        ? req.body.projectId
        : undefined;
    const principal = await identityService.resolve(requestAuthorization(req), projectId);
    assertCookieCsrf(req, principal);
    if (
      getDeploymentMode() === "isolated-hosted" &&
      /\/(dev-server|open-editor|scaffold|fs|env|commands)(?:\/|$)/.test(policyPath)
    )
      throw new AppError(
        403,
        "HOST_EXECUTION_DISABLED",
        "This host action is unavailable in isolated deployment mode."
      );
    if (!principal.local) {
      const original = res.json.bind(res);
      res.json = (value) => original(redactNamedResponse(value));
      const discovery = req.method === "GET" && ["/projects", "/db-status"].includes(policyPath);
      if (!projectId && !discovery)
        throw new AppError(
          403,
          "HOST_PERMISSION_REQUIRED",
          "This endpoint requires host permission."
        );
      // Credentials, host filesystem and arbitrary command interpretation are never delegated by read/edit.
      if (/\/integrations(?:\/|$)|\/open-editor(?:\/|$)|\/commands(?:\/|$)/.test(policyPath))
        throw new AppError(
          403,
          "HOST_PERMISSION_REQUIRED",
          "This endpoint requires host permission."
        );
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        /^\/projects\/[^/]+$/.test(policyPath)
      )
        throw new AppError(
          403,
          "HOST_PERMISSION_REQUIRED",
          "Only the host can change project repository configuration."
        );
      if (
        policyPath.endsWith("/settings") &&
        req.method !== "GET" &&
        JSON.stringify(req.body ?? {}).match(/"(?:envVars|expoToken|apiKeys|clientSecret)"\s*:/)
      )
        throw new AppError(
          403,
          "HOST_PERMISSION_REQUIRED",
          "Only the host can change deployment credentials and environment values."
        );
      if (projectId)
        identityService.require(principal, permissionForRequest(req.method, policyPath));
    }
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const requestId = req.headers["idempotency-key"];
    const rawRevision = req.headers["if-match"];
    const normalized =
      typeof rawRevision === "string"
        ? rawRevision.replace(/^W\//, "").replace(/^"|"$/g, "")
        : undefined;
    const expectedRevision =
      normalized !== undefined &&
      /^\d+$/.test(normalized) &&
      Number.isSafeInteger(Number(normalized))
        ? Number(normalized)
        : undefined;
    const resource = policyPath.match(
      /^\/projects\/[^/]+\/(tasks|plans|notifications)\/([^/]+)(?:\/|$)/
    );
    const revisionRequired =
      policyPath.endsWith("/settings") ||
      !!(
        resource &&
        !(
          resource[1] === "plans" &&
          ["decompose", "generate", "suggest", "execute-batch"].includes(resource[2]!)
        )
      );
    if (
      !principal.local &&
      mutating &&
      (typeof requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId))
    )
      throw new AppError(
        400,
        "REQUEST_ID_REQUIRED",
        "Use a stable Idempotency-Key for this action."
      );
    if (!principal.local && mutating && revisionRequired && expectedRevision === undefined)
      throw new AppError(
        428,
        "EXPECTED_REVISION_REQUIRED",
        "Use If-Match with the displayed revision."
      );
    runWithRequestContext(
      {
        principal,
        projectId,
        requestId: typeof requestId === "string" ? requestId : undefined,
        expectedRevision,
      },
      next
    );
  })().catch(next);
}
