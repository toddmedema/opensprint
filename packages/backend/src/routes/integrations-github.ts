/**
 * GitHub Issues integration routes.
 *
 * POST /connect       — store a user-supplied PAT and activate the connection
 * GET  /status        — returns current integration connection status
 * GET  /repos         — lists repos accessible with the stored PAT
 * PUT  /repo          — selects a GitHub repo for issue sync
 * POST /sync          — import open GitHub issues as linked planning plans
 * DELETE /            — disconnect (delete stored connection)
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { projectIdParamSchema } from "../schemas/request-common.js";
import type { IntegrationStoreService } from "../services/integration-store.service.js";
import type { TokenEncryptionService } from "../services/token-encryption.service.js";
import type { IntakeIngestionService } from "../services/intake-ingestion.service.js";
import type {
  IntegrationStatusResponse,
  IntegrationSourceOption,
  IntegrationSyncResponse,
} from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { githubAdapter } from "../services/adapters/github-adapter.js";
import { githubRequest, GitHubApiError } from "../services/github-api.js";
import { AppError } from "../middleware/error-handler.js";

const log = createLogger("github-integration");

const SYNC_RATE_LIMIT_MS = 10_000;

const connectBodySchema = z.object({
  token: z.string().trim().min(1, "token is required"),
});

const selectRepoBodySchema = z.object({
  repoId: z.string().regex(/^\d+$/, "repoId must be a GitHub repository ID"),
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Select an owner/repository"),
});

export interface GitHubIntegrationRouterDeps {
  integrationStore: Pick<
    IntegrationStoreService,
    | "upsertConnection"
    | "getConnection"
    | "getEncryptedTokenById"
    | "updateConnectionStatus"
    | "updateSelectedResource"
    | "deleteConnection"
  >;
  tokenEncryption: Pick<TokenEncryptionService, "encryptToken" | "decryptToken">;
  intakeIngestion?: Pick<IntakeIngestionService, "ingestFromConnection">;
}

type ProjectParams = { projectId: string };

async function verifyGitHubToken(token: string): Promise<{ login: string } | null> {
  try {
    const data = await githubRequest<{ login?: string }>("/user", token);
    return data.login ? { login: data.login } : null;
  } catch {
    return null;
  }
}

function tryDecryptToken(
  enc: Pick<TokenEncryptionService, "decryptToken">,
  encryptedToken: string
): string | null {
  try {
    return enc.decryptToken(encryptedToken);
  } catch {
    return null;
  }
}

export function createGitHubIntegrationRouter(deps: GitHubIntegrationRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const { integrationStore, tokenEncryption } = deps;

  // POST /connect
  router.post(
    "/connect",
    validateParams(projectIdParamSchema),
    validateBody(connectBodySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const { token } = req.body as z.infer<typeof connectBodySchema>;

      const user = await verifyGitHubToken(token);
      if (!user) {
        res.status(401).json({
          error: {
            code: "INVALID_TOKEN",
            message: "The provided GitHub token is invalid or lacks required permissions.",
          },
        });
        return;
      }

      const encryptedToken = tokenEncryption.encryptToken(token);
      const existing = await integrationStore.getConnection(projectId, "github");

      await integrationStore.upsertConnection({
        project_id: projectId,
        provider: "github",
        provider_user_id: user.login,
        access_token_enc: encryptedToken,
        scopes: "repo",
        status: "active",
        ...(existing?.provider_user_id === user.login
          ? {
              provider_resource_id: existing.provider_resource_id,
              provider_resource_name: existing.provider_resource_name,
            }
          : {}),
      });

      log.info("GitHub connected", { projectId, user: user.login });

      res.json({
        data: { success: true, user: user.login },
      });
    })
  );

  // GET /status
  router.get(
    "/status",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const connection = await integrationStore.getConnection(projectId, "github");

      if (!connection) {
        const body: { data: IntegrationStatusResponse } = {
          data: {
            connected: false,
            provider: "github",
            status: "disabled",
          },
        };
        res.json(body);
        return;
      }

      const status: IntegrationStatusResponse = {
        connected: true,
        provider: "github",
        status: connection.status,
      };

      if (connection.provider_user_id) {
        status.user = { id: connection.provider_user_id };
      }

      if (connection.provider_resource_id) {
        status.selectedSource = {
          id: connection.provider_resource_id,
          name: connection.provider_resource_name ?? connection.provider_resource_id,
        };
      }

      if (connection.last_sync_at) {
        status.lastSyncAt = connection.last_sync_at;
      }

      if (connection.last_error) {
        status.lastError = connection.last_error;
      }

      res.json({ data: status });
    })
  );

  // GET /repos
  router.get(
    "/repos",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const connection = await integrationStore.getConnection(projectId, "github");

      if (!connection) {
        res.status(404).json({
          error: {
            code: "NOT_CONNECTED",
            message: "GitHub is not connected for this project.",
          },
        });
        return;
      }

      if (connection.status !== "active") {
        res.status(409).json({
          error: {
            code: "NEEDS_RECONNECT",
            message: "GitHub connection requires a new token. Please reconnect.",
          },
        });
        return;
      }

      const encryptedToken = await integrationStore.getEncryptedTokenById(connection.id);
      if (!encryptedToken) {
        res.status(500).json({
          error: {
            code: "TOKEN_MISSING",
            message: "Stored token could not be retrieved.",
          },
        });
        return;
      }

      const accessToken = tryDecryptToken(tokenEncryption, encryptedToken);
      if (!accessToken) {
        res.status(500).json({
          error: { code: "TOKEN_DECRYPT_FAILED", message: "Failed to decrypt stored token." },
        });
        return;
      }

      try {
        const repos: IntegrationSourceOption[] = await githubAdapter.listSources(
          connection,
          accessToken
        );
        log.info("Listed GitHub repos", {
          projectId,
          count: repos.length,
        });
        res.json({ data: { repos } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof GitHubApiError && err.needsReconnect) {
          await integrationStore.updateConnectionStatus(connection.id, "needs_reconnect", msg);
          res.status(401).json({
            error: {
              code: "GITHUB_AUTH_FAILED",
              message: "GitHub authentication failed. Please reconnect with a valid token.",
            },
          });
          return;
        }
        throw new AppError(
          err instanceof GitHubApiError && err.rateLimited ? 429 : 502,
          "GITHUB_REQUEST_FAILED",
          msg
        );
      }
    })
  );

  // PUT /repo
  router.put(
    "/repo",
    validateParams(projectIdParamSchema),
    validateBody(selectRepoBodySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const { repoId, repoFullName } = req.body as z.infer<typeof selectRepoBodySchema>;

      const connection = await integrationStore.getConnection(projectId, "github");
      if (!connection) {
        res.status(404).json({
          error: {
            code: "NOT_CONNECTED",
            message: "GitHub is not connected for this project.",
          },
        });
        return;
      }

      if (connection.status !== "active") {
        throw new AppError(
          409,
          "NEEDS_RECONNECT",
          "Reconnect GitHub before selecting a repository."
        );
      }
      const encryptedToken = await integrationStore.getEncryptedTokenById(connection.id);
      const token = encryptedToken ? tryDecryptToken(tokenEncryption, encryptedToken) : null;
      if (!token)
        throw new AppError(409, "NEEDS_RECONNECT", "Reconnect GitHub to restore your token.");
      let repo: { id: number; full_name: string; has_issues?: boolean };
      try {
        repo = await githubRequest(`/repositories/${repoId}`, token);
      } catch (err) {
        if (err instanceof GitHubApiError && err.needsReconnect) {
          await integrationStore.updateConnectionStatus(
            connection.id,
            "needs_reconnect",
            err.message
          );
        }
        throw new AppError(
          err instanceof GitHubApiError && err.rateLimited ? 429 : 400,
          "GITHUB_REPO_UNAVAILABLE",
          "Repository is unavailable. Check access and token permissions."
        );
      }
      if (
        String(repo.id) !== repoId ||
        repo.full_name.toLowerCase() !== repoFullName.toLowerCase() ||
        repo.has_issues === false
      ) {
        throw new AppError(
          400,
          "INVALID_REPOSITORY",
          "Select an accessible repository with issues enabled."
        );
      }
      await integrationStore.updateSelectedResource(connection.id, repoId, repo.full_name);

      log.info("GitHub repo selected", {
        projectId,
        repoId,
        repoFullName,
      });

      res.json({
        data: {
          success: true,
          selectedSource: { id: repoId, name: repo.full_name },
        },
      });
    })
  );

  // POST /sync
  router.post(
    "/sync",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const connection = await integrationStore.getConnection(projectId, "github");

      if (!connection) {
        res.status(404).json({
          error: {
            code: "NOT_CONNECTED",
            message: "GitHub is not connected for this project.",
          },
        });
        return;
      }

      if (connection.status !== "active") {
        res.status(409).json({
          error: {
            code: "NEEDS_RECONNECT",
            message: "GitHub connection requires a new token. Please reconnect.",
          },
        });
        return;
      }

      if (!connection.provider_resource_name) {
        res.status(400).json({
          error: {
            code: "NO_REPO_SELECTED",
            message: "No repository selected. Please select a repository before syncing.",
          },
        });
        return;
      }

      if (connection.last_sync_at) {
        const lastSyncMs = new Date(connection.last_sync_at).getTime();
        if (Date.now() - lastSyncMs < SYNC_RATE_LIMIT_MS) {
          res.status(429).json({
            error: {
              code: "SYNC_RATE_LIMITED",
              message:
                "Sync was triggered too recently. Please wait at least 10 seconds between syncs.",
            },
          });
          return;
        }
      }

      if (!deps.intakeIngestion) {
        res.status(500).json({
          error: {
            code: "SYNC_NOT_AVAILABLE",
            message: "Intake ingestion service is not configured.",
          },
        });
        return;
      }

      let ingestionResult;
      try {
        ingestionResult = await deps.intakeIngestion.ingestFromConnection(connection.id);
      } catch (err) {
        throw new AppError(
          err instanceof GitHubApiError && err.rateLimited ? 429 : 502,
          err instanceof GitHubApiError && err.rateLimited ? "RATE_LIMITED" : "GITHUB_SYNC_FAILED",
          err instanceof Error ? err.message : "GitHub sync failed. Please try again."
        );
      }

      log.info("GitHub sync completed", {
        projectId,
        imported: ingestionResult.imported,
        errors: ingestionResult.errors,
      });

      const body: { data: IntegrationSyncResponse } = {
        data: {
          imported: ingestionResult.imported,
          errors: ingestionResult.errors,
        },
      };
      res.json(body);
    })
  );

  // DELETE /
  router.delete(
    "/",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const connection = await integrationStore.getConnection(projectId, "github");

      if (!connection) {
        res.status(404).json({
          error: {
            code: "NOT_CONNECTED",
            message: "GitHub is not connected for this project.",
          },
        });
        return;
      }

      await integrationStore.deleteConnection(projectId, "github");

      log.info("GitHub disconnected", { projectId });

      res.json({ data: { disconnected: true } });
    })
  );

  return router;
}
