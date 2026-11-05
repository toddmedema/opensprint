/**
 * Intake ingestion pipeline: fetch -> normalize -> dedupe -> persist.
 * Provider-agnostic — works with any registered IntegrationAdapter.
 */

import type { IntegrationProvider, ServerEvent } from "@opensprint/shared";
import { adapterRegistry } from "./integration-adapter.js";
import type { RawExternalItem } from "./integration-adapter.js";
import { intakeStore } from "./intake-store.service.js";
import { integrationStore } from "./integration-store.service.js";
import { tokenEncryption } from "./token-encryption.service.js";
import { createLogger } from "../utils/logger.js";
import { githubPlanImport } from "./github-plan-import.service.js";
import { GitHubApiError } from "./github-api.js";
import { broadcastToProject } from "../websocket/index.js";

const log = createLogger("intake-ingestion");

export interface IngestionResult {
  imported: number;
  skipped: number;
  errors: number;
}

export class IntakeIngestionService {
  private broadcastToProject?: (projectId: string, event: ServerEvent) => void;

  constructor(opts?: { broadcastToProject?: (projectId: string, event: ServerEvent) => void }) {
    this.broadcastToProject = opts?.broadcastToProject;
  }

  /**
   * Run the full ingestion cycle for a connection.
   * Fetch items from the provider, normalize, dedupe, and persist.
   */
  async ingestFromConnection(connectionId: string): Promise<IngestionResult> {
    const result: IngestionResult = { imported: 0, skipped: 0, errors: 0 };

    const connection = await integrationStore.getConnectionById(connectionId);
    if (!connection) {
      log.warn("Connection not found", { connectionId });
      return result;
    }

    if (connection.status !== "active") {
      log.warn("Connection not active, skipping", { connectionId, status: connection.status });
      return result;
    }

    const adapter = adapterRegistry.get(connection.provider);
    if (!adapter) {
      log.error("No adapter for provider", { provider: connection.provider });
      return result;
    }

    const encryptedToken = await integrationStore.getEncryptedTokenById(connectionId);
    if (!encryptedToken) {
      log.error("No token for connection", { connectionId });
      if (connection.provider === "github")
        throw new Error("GitHub token is missing. Please reconnect.");
      return result;
    }

    let decryptedToken: string;
    try {
      decryptedToken = tokenEncryption.decryptToken(encryptedToken);
    } catch (err) {
      log.error("Token decryption failed", { connectionId, error: String(err) });
      if (connection.provider === "github")
        throw new Error("GitHub token could not be read. Please reconnect.");
      return result;
    }

    this.broadcast(connection.project_id, {
      type: "integration.sync.started",
      provider: connection.provider,
      projectId: connection.project_id,
    });

    try {
      const rawItems = await adapter.fetchItems(connection, decryptedToken);

      for (const raw of rawItems) {
        try {
          if (connection.provider === "github") {
            if (await githubPlanImport.importIssue(connection.project_id, raw)) result.imported++;
            else result.skipped++;
            continue;
          }
          const normalized = adapter.normalizeItem(raw);
          const { created } = await intakeStore.upsertItem({
            project_id: connection.project_id,
            provider: connection.provider,
            ...normalized,
          });

          if (created) {
            result.imported++;
          } else {
            result.skipped++;
          }
        } catch (err) {
          log.error("Failed to process item", {
            connectionId,
            externalId: raw.externalId,
            error: String(err),
          });
          result.errors++;
        }
      }

      await integrationStore.updateLastSync(
        connectionId,
        new Date().toISOString(),
        result.errors ? `${result.errors} item(s) could not be imported. Try syncing again.` : null
      );

      this.broadcast(connection.project_id, {
        type: "integration.sync.completed",
        provider: connection.provider,
        projectId: connection.project_id,
        imported: result.imported,
        errors: result.errors,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Ingestion cycle failed", { connectionId, error: errMsg });
      await integrationStore.updateLastSync(connectionId, new Date().toISOString(), errMsg);
      if (connection.provider === "github" && err instanceof GitHubApiError && err.needsReconnect) {
        await integrationStore.updateConnectionStatus(connectionId, "needs_reconnect", errMsg);
      }

      this.broadcast(connection.project_id, {
        type: "integration.sync.error",
        provider: connection.provider,
        projectId: connection.project_id,
        error: errMsg,
      });
      if (connection.provider === "github") throw err;
    }

    return result;
  }

  /**
   * Ingest raw items directly (for webhook push-based providers).
   */
  async ingestRawItems(
    projectId: string,
    provider: IntegrationProvider,
    rawItems: RawExternalItem[]
  ): Promise<IngestionResult> {
    const result: IngestionResult = { imported: 0, skipped: 0, errors: 0 };

    const adapter = adapterRegistry.get(provider);
    if (!adapter) {
      log.error("No adapter for provider", { provider });
      return result;
    }

    for (const raw of rawItems) {
      try {
        const normalized = adapter.normalizeItem(raw);
        const { created } = await intakeStore.upsertItem({
          project_id: projectId,
          provider,
          ...normalized,
        });

        if (created) {
          result.imported++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        log.error("Failed to ingest raw item", {
          provider,
          externalId: raw.externalId,
          error: String(err),
        });
        result.errors++;
      }
    }

    return result;
  }

  /**
   * Run ingestion for all active connections of a specific provider,
   * or all providers if none specified.
   */
  async ingestAll(provider?: IntegrationProvider): Promise<IngestionResult> {
    const connections = await integrationStore.getActiveConnections(provider);
    const totals: IngestionResult = { imported: 0, skipped: 0, errors: 0 };

    for (const conn of connections) {
      const r = await this.ingestFromConnection(conn.id);
      totals.imported += r.imported;
      totals.skipped += r.skipped;
      totals.errors += r.errors;
    }

    return totals;
  }

  private broadcast(projectId: string, event: ServerEvent): void {
    try {
      this.broadcastToProject?.(projectId, event);
    } catch {
      // never let broadcast failures interrupt ingestion
    }
  }
}

export const intakeIngestion = new IntakeIngestionService({ broadcastToProject });
