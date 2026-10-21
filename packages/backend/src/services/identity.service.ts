import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getRequestContext } from "./request-context.js";
import { databaseNow } from "../db/database-clock.js";
import {
  PROJECT_PERMISSIONS,
  type ProjectIdentity,
  type ProjectPermission,
  type CollaborationRole,
} from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import type { DbClient } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { requestHasValidBearerToken } from "./local-session-auth.service.js";
import { createCollaborationAccess } from "./collaboration-access.service.js";
import { appendProjectEvent, lockProject } from "./project-event.service.js";

interface IdentityStore {
  getDb(): Promise<DbClient>;
  runWrite<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
export const credentialHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function localIdentity(): ProjectIdentity {
  return {
    actorId: "local-user",
    displayName: "Host",
    role: "controller",
    permissions: [...PROJECT_PERMISSIONS],
    local: true,
  };
}
const legacyPermissions = (role: CollaborationRole): ProjectPermission[] =>
  role === "viewer"
    ? ["read"]
    : role === "participant"
      ? ["read", "discuss"]
      : ["read", "discuss", "control"];
function denied(message = "Project membership does not grant this action."): never {
  throw new AppError(403, "PROJECT_ACCESS_DENIED", message);
}

export class IdentityService {
  constructor(private readonly store: IdentityStore = taskStore) {}
  async resolve(authorization: string | undefined, projectId?: string): Promise<ProjectIdentity> {
    if (requestHasValidBearerToken(authorization)) return localIdentity();
    const token = authorization?.match(/^Bearer ([^\s]{1,4096})$/)?.[1];
    if (!token)
      throw new AppError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Sign in with your invitation or access token."
      );
    // Existing configured credentials are retained as a migration path.
    if (projectId) {
      try {
        const legacy = await createCollaborationAccess().resolve(authorization, projectId);
        return {
          ...legacy,
          permissions: legacyPermissions(legacy.role),
          local: false,
          credentialHash: credentialHash(token),
        };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
      }
    }
    return this.resolveHash(credentialHash(token), projectId);
  }
  async resolveHash(hash: string, projectId?: string): Promise<ProjectIdentity> {
    const legacy = projectId ? createCollaborationAccess().resolveHash?.(hash, projectId) : null;
    if (legacy)
      return {
        ...legacy,
        permissions: legacyPermissions(legacy.role),
        local: false,
        credentialHash: hash,
      };
    const db = await this.store.getDb();
    const actor = await db.queryOne(
      `SELECT u.actor_id, u.display_name FROM collaboration_credentials c
      JOIN collaboration_users u ON u.actor_id = c.actor_id WHERE c.token_hash = $1 AND c.revoked = 0
      AND c.expires_at > $2 AND u.disabled = 0`,
      [hash, new Date(await databaseNow(db)).toISOString()]
    );
    if (!actor)
      throw new AppError(401, "CREDENTIAL_EXPIRED", "This access token expired or was revoked.");
    if (!projectId)
      return {
        actorId: String(actor.actor_id),
        displayName: String(actor.display_name),
        role: "viewer",
        permissions: [],
        local: false,
        credentialHash: hash,
      };
    return this.member(String(actor.actor_id), projectId, hash);
  }
  async member(actorId: string, projectId: string, hash?: string): Promise<ProjectIdentity> {
    if (actorId === "local-user") return localIdentity();
    const db = await this.store.getDb();
    const row = await db.queryOne(
      `SELECT m.role, m.permissions, u.display_name FROM collaboration_memberships m
      JOIN collaboration_users u ON u.actor_id = m.actor_id WHERE m.actor_id = $1 AND m.project_id = $2 AND u.disabled = 0`,
      [actorId, projectId]
    );
    if (!row) denied();
    return {
      actorId,
      displayName: String(row.display_name),
      role: row.role as CollaborationRole,
      permissions: JSON.parse(String(row.permissions)) as ProjectPermission[],
      local: false,
      credentialHash: hash,
    };
  }
  require(principal: ProjectIdentity, permission: ProjectPermission): void {
    if (!principal.permissions.includes(permission)) denied();
  }
  async createInvitation(
    projectId: string,
    input: {
      displayName: string;
      role: CollaborationRole;
      permissions: ProjectPermission[];
      ttlMinutes?: number;
    }
  ): Promise<{ token: string; actorId: string; expiresAt: string }> {
    const actorId = `user-${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = await this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const now = await databaseNow(tx);
      const expiresAt = new Date(now + (input.ttlMinutes ?? 60) * 60_000).toISOString();
      await tx.execute(
        "INSERT INTO collaboration_users (actor_id, display_name, created_at) VALUES ($1, $2, $3)",
        [actorId, input.displayName, new Date(now).toISOString()]
      );
      await tx.execute(
        "INSERT INTO collaboration_memberships (project_id, actor_id, role, permissions) VALUES ($1, $2, $3, $4)",
        [
          projectId,
          actorId,
          input.role,
          JSON.stringify([...new Set(["read", ...input.permissions])]),
        ]
      );
      await tx.execute(
        "INSERT INTO collaboration_invitations (token_hash, project_id, actor_id, expires_at) VALUES ($1, $2, $3, $4)",
        [credentialHash(token), projectId, actorId, expiresAt]
      );
      await appendProjectEvent(tx, {
        projectId,
        type: "membership_changed",
        actorId: getRequestContext()?.principal.actorId ?? "local-user",
        payload: { actorId, revision: 1 },
      });
      return expiresAt;
    });
    return { token, actorId, expiresAt };
  }
  async redeemInvitation(
    token: string
  ): Promise<{ token: string; projectId: string; actorId: string; expiresAt: string }> {
    const fresh = randomBytes(32).toString("base64url");
    return this.store.runWrite(async (tx) => {
      const now = await databaseNow(tx);
      const expiresAt = new Date(now + 7 * 24 * 3600_000).toISOString();
      const invite = await tx.queryOne(
        `UPDATE collaboration_invitations SET consumed_at = $2 WHERE token_hash = $1
        AND consumed_at IS NULL AND expires_at > $2 RETURNING project_id, actor_id`,
        [credentialHash(token), new Date(now).toISOString()]
      );
      if (!invite)
        throw new AppError(
          401,
          "INVITATION_EXPIRED",
          "This invitation expired or was already used."
        );
      await tx.execute(
        "INSERT INTO collaboration_credentials (token_hash, actor_id, expires_at) VALUES ($1, $2, $3)",
        [credentialHash(fresh), invite.actor_id, expiresAt]
      );
      return {
        token: fresh,
        projectId: String(invite.project_id),
        actorId: String(invite.actor_id),
        expiresAt,
      };
    });
  }
  async listMemberships(projectId: string): Promise<unknown[]> {
    const db = await this.store.getDb();
    return db.query(
      `SELECT m.actor_id, u.display_name, m.role, m.permissions, m.revision, u.disabled FROM collaboration_memberships m JOIN collaboration_users u ON u.actor_id = m.actor_id WHERE m.project_id = $1 ORDER BY u.display_name`,
      [projectId]
    );
  }
  async updateMembership(
    projectId: string,
    actorId: string,
    input: { role: CollaborationRole; permissions: ProjectPermission[]; expectedRevision: number }
  ): Promise<void> {
    await this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const changed = await tx.execute(
        `UPDATE collaboration_memberships SET role = $3, permissions = $4, revision = revision + 1 WHERE project_id = $1 AND actor_id = $2 AND revision = $5`,
        [
          projectId,
          actorId,
          input.role,
          JSON.stringify([...new Set(["read", ...input.permissions])]),
          input.expectedRevision,
        ]
      );
      if (changed !== 1)
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          "Membership changed. Refresh before updating."
        );
      await appendProjectEvent(tx, {
        projectId,
        type: "membership_changed",
        actorId: getRequestContext()?.principal.actorId ?? "local-user",
        payload: { actorId, revision: input.expectedRevision + 1 },
      });
    });
  }
  async revokeActor(projectId: string, actorId: string): Promise<void> {
    await this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      await tx.execute(
        "DELETE FROM collaboration_memberships WHERE project_id = $1 AND actor_id = $2",
        [projectId, actorId]
      );
      await appendProjectEvent(tx, {
        projectId,
        type: "membership_changed",
        actorId: getRequestContext()?.principal.actorId ?? "local-user",
        payload: { actorId, revoked: true },
      });
    });
  }
  async accessibleProjects(actorId: string): Promise<string[]> {
    const db = await this.store.getDb();
    return (
      await db.query("SELECT project_id FROM collaboration_memberships WHERE actor_id = $1", [
        actorId,
      ])
    ).map((row) => String(row.project_id));
  }
}
export const identityService = new IdentityService();
