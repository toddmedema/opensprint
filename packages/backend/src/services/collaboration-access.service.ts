import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CollaborationPrincipal } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { requestHasValidBearerToken } from "./local-session-auth.service.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const tokenSchema = z
  .array(
    z
      .object({
        tokenHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
        actorId: identifier.refine((v) => v !== "local-user"),
        displayName: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((v) => !v.includes("\u0000")),
        projects: z.record(identifier, z.enum(["viewer", "participant", "controller"])),
      })
      .strict()
  )
  .max(256);

export interface CollaborationAccess {
  resolve(
    authorization: string | undefined,
    projectId: string
  ): CollaborationPrincipal | Promise<CollaborationPrincipal>;
  canControlActor(projectId: string, actorId: string): boolean | Promise<boolean>;
  resolveHash?(hash: string, projectId: string): CollaborationPrincipal | null;
}

/**
 * Explicit project-scoped pilot credentials, deliberately separate from the
 * local-session credential that grants access to the existing application.
 * Only hashes belong in server configuration. Caller-supplied actor headers
 * and body fields never establish identity or project membership.
 */
export function createCollaborationAccess(
  configuration = process.env.OPENSPRINT_COLLABORATION_TOKENS
): CollaborationAccess {
  let tokens: z.infer<typeof tokenSchema> = [];
  try {
    tokens = tokenSchema.parse(configuration ? JSON.parse(configuration) : []);
    if (
      new Set(tokens.map((t) => t.actorId)).size !== tokens.length ||
      new Set(tokens.map((t) => t.tokenHash.toLowerCase())).size !== tokens.length
    ) {
      throw new Error("Duplicate actor or credential");
    }
  } catch {
    throw new Error(
      "OPENSPRINT_COLLABORATION_TOKENS must be a valid array of unique hashed actor credentials with project roles."
    );
  }
  return {
    resolveHash(hash, projectId) {
      const entry = tokens.find((token) => token.tokenHash.toLowerCase() === hash.toLowerCase());
      const role = entry?.projects[projectId];
      return entry && role
        ? { actorId: entry.actorId, displayName: entry.displayName, role }
        : null;
    },
    resolve(authorization, projectId) {
      if (requestHasValidBearerToken(authorization))
        return { actorId: "local-user", displayName: "Local user", role: "controller" };
      const bearer = authorization?.match(/^Bearer ([^\s]{1,4096})$/)?.[1];
      const hash = bearer ? createHash("sha256").update(bearer).digest() : null;
      const entry = hash
        ? tokens.find((t) => timingSafeEqual(hash, Buffer.from(t.tokenHash, "hex")))
        : undefined;
      if (!entry)
        throw new AppError(
          401,
          "COLLABORATION_UNAUTHENTICATED",
          "A valid local session or project collaboration bearer token is required."
        );
      const role = entry.projects[projectId];
      if (!role)
        throw new AppError(
          403,
          "COLLABORATION_FORBIDDEN",
          "This credential has no access to this project."
        );
      return { actorId: entry.actorId, displayName: entry.displayName, role };
    },
    canControlActor(projectId, actorId) {
      return (
        actorId === "local-user" ||
        tokens.some((t) => t.actorId === actorId && t.projects[projectId] === "controller")
      );
    },
  };
}
