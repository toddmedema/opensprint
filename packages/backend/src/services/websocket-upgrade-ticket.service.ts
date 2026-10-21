import { randomBytes } from "node:crypto";
import { taskStore } from "./task-store.service.js";
import { credentialHash } from "./identity.service.js";
export interface UpgradeClaims {
  projectId: string;
  credentialHash: string;
}
export async function issueScopedWebSocketTicket(claims: UpgradeClaims): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await taskStore.runWrite(async (tx) => {
    await tx.execute("DELETE FROM websocket_upgrade_tickets WHERE expires_at <= $1", [
      new Date().toISOString(),
    ]);
    await tx.execute(
      "INSERT INTO websocket_upgrade_tickets (token_hash,project_id,credential_hash,expires_at) VALUES ($1,$2,$3,$4)",
      [
        credentialHash(token),
        claims.projectId,
        claims.credentialHash,
        new Date(Date.now() + TTL_MS).toISOString(),
      ]
    );
  });
  return token;
}
export async function consumeScopedWebSocketTicket(token: string): Promise<UpgradeClaims | null> {
  return taskStore.runWrite(async (tx) => {
    const row = await tx.queryOne(
      "DELETE FROM websocket_upgrade_tickets WHERE token_hash=$1 AND expires_at>$2 RETURNING project_id,credential_hash",
      [credentialHash(token), new Date().toISOString()]
    );
    return row
      ? { projectId: String(row.project_id), credentialHash: String(row.credential_hash) }
      : null;
  });
}

const TTL_MS = 120_000;

const tickets = new Map<string, number>();

function pruneExpiredWebSocketUpgradeTickets(now: number): void {
  for (const [ticket, expiresAt] of tickets) {
    if (expiresAt <= now) {
      tickets.delete(ticket);
    }
  }
}

/** Issue a one-time WebSocket upgrade ticket (valid ~2 minutes until consumed). */
export function issueWebSocketUpgradeTicket(): string {
  const now = Date.now();
  pruneExpiredWebSocketUpgradeTickets(now);
  const id = randomBytes(32).toString("base64url");
  tickets.set(id, now + TTL_MS);
  return id;
}

/**
 * Validates and consumes a ticket. Returns false for unknown, expired, empty, or reused tickets.
 */
export function consumeWebSocketUpgradeTicket(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  pruneExpiredWebSocketUpgradeTickets(Date.now());
  const expiresAt = tickets.get(trimmed);
  if (expiresAt == null) return false;
  tickets.delete(trimmed);
  if (Date.now() > expiresAt) return false;
  return true;
}

/** Test helper: clear in-memory tickets between tests. */
export function clearWebSocketUpgradeTicketsForTesting(): void {
  tickets.clear();
}

/** Test helper: current number of tracked in-memory tickets. */
export function getWebSocketUpgradeTicketCountForTesting(): number {
  return tickets.size;
}
