import { Router } from "express";
import { z } from "zod";
import { PROJECT_PERMISSIONS } from "@opensprint/shared";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody } from "../middleware/validate.js";
import { identityService, credentialHash } from "../services/identity.service.js";
import {
  assertCookieCsrf,
  csrfToken,
  requestAuthorization,
  SESSION_COOKIE,
} from "../middleware/project-access.js";
import { taskStore } from "../services/task-store.service.js";
import { getDeploymentMode } from "../services/deployment-mode.js";
const tokenSchema = z.object({ token: z.string().min(32).max(4096) }).strict();
function cookie(token: string, clear = false): string {
  return `${SESSION_COOKIE}=${clear ? "" : token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 604800}${getDeploymentMode() === "trusted-local" ? "" : "; Secure"}`;
}
export function createIdentityRouter() {
  const router = Router();
  router.post(
    "/redeem",
    validateBody(tokenSchema),
    wrapAsync(async (req, res) => {
      const redeemed = await identityService.redeemInvitation(req.body.token);
      const principal = await identityService.resolve(
        `Bearer ${redeemed.token}`,
        redeemed.projectId
      );
      res.setHeader("Set-Cookie", cookie(redeemed.token));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        data: { projectId: redeemed.projectId, principal, csrfToken: csrfToken(principal) },
      });
    })
  );
  router.get(
    "/session",
    wrapAsync(async (req, res) => {
      const principal = await identityService.resolve(
        requestAuthorization(req),
        typeof req.query.projectId === "string" ? req.query.projectId : undefined
      );
      const projects = principal.local
        ? null
        : await identityService.accessibleProjects(principal.actorId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { principal, projects, csrfToken: csrfToken(principal) } });
    })
  );
  router.post(
    "/session",
    validateBody(tokenSchema),
    wrapAsync(async (req, res) => {
      const principal = await identityService.resolve(`Bearer ${req.body.token}`);
      res.setHeader("Set-Cookie", cookie(req.body.token));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { principal, csrfToken: csrfToken(principal) } });
    })
  );
  router.delete(
    "/session",
    wrapAsync(async (req, res) => {
      const authorization = requestAuthorization(req);
      const principal = await identityService.resolve(authorization);
      assertCookieCsrf(req, principal);
      if (!principal.local && authorization)
        await taskStore.runWrite((tx) =>
          tx.execute("UPDATE collaboration_credentials SET revoked = 1 WHERE token_hash = $1", [
            credentialHash(authorization.slice(7)),
          ])
        );
      res.setHeader("Set-Cookie", cookie("", true));
      res.status(204).send();
    })
  );
  return router;
}
const membership = z
  .object({
    role: z.enum(["viewer", "participant", "controller"]),
    permissions: z.array(z.enum(PROJECT_PERMISSIONS)).max(8),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export function createMembershipRouter() {
  const router = Router({ mergeParams: true });
  router.use(
    wrapAsync(async (req, _res, next) => {
      const principal = await identityService.resolve(
        requestAuthorization(req),
        String(req.params.projectId)
      );
      identityService.require(principal, req.method === "GET" ? "read" : "manage");
      next();
    })
  );
  router.get(
    "/",
    wrapAsync(async (req, res) =>
      res.json({ data: await identityService.listMemberships(String(req.params.projectId)) })
    )
  );
  router.post(
    "/invitations",
    validateBody(
      membership.omit({ expectedRevision: true }).extend({
        displayName: z.string().trim().min(1).max(120),
        ttlMinutes: z.number().int().min(1).max(10080).optional(),
      })
    ),
    wrapAsync(async (req, res) =>
      res.json({
        data: await identityService.createInvitation(String(req.params.projectId), req.body),
      })
    )
  );
  router.put(
    "/:actorId",
    validateBody(membership),
    wrapAsync(async (req, res) => {
      await identityService.updateMembership(
        String(req.params.projectId),
        String(req.params.actorId),
        req.body
      );
      res.status(204).send();
    })
  );
  router.delete(
    "/:actorId",
    wrapAsync(async (req, res) => {
      await identityService.revokeActor(String(req.params.projectId), String(req.params.actorId));
      res.status(204).send();
    })
  );
  return router;
}
