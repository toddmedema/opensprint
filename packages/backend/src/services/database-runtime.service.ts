import pg from "pg";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { createLogger } from "../utils/logger.js";
import { getPoolConfig } from "../db/client.js";
import { classifyDbConnectionError, isDbConnectionError } from "../db/db-errors.js";
import {
  getEffectiveDatabaseConfig,
  type DatabaseUrlSource,
} from "./global-settings.service.js";

const log = createLogger("database-runtime");
const TEST_DB_NAME = "opensprint_test";

export type DatabaseRuntimeState = "connected" | "connecting" | "disconnected";

export interface DbStatusResponse {
  ok: boolean;
  message?: string;
  state: DatabaseRuntimeState;
  lastCheckedAt: string | null;
}

export interface DatabaseStatusSnapshot {
  ok: boolean;
  message: string | null;
  state: DatabaseRuntimeState;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export interface DatabaseRuntimeConfig {
  databaseUrl: string;
  source: DatabaseUrlSource;
}

interface DatabaseRuntimeDependencies {
  resolveConfig: () => Promise<DatabaseRuntimeConfig>;
  probe: (databaseUrl: string) => Promise<void>;
  retryCooldownMs: number;
  initialSnapshot: DatabaseStatusSnapshot;
}

interface LifecycleContext extends DatabaseRuntimeConfig {
  reason: string;
  message: string | null;
}

interface DatabaseRuntimeLifecycleHandlers {
  onConnected?: (context: LifecycleContext) => Promise<void> | void;
  onDisconnected?: (context: LifecycleContext) => Promise<void> | void;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

async function probeDatabase(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool(getPoolConfig(databaseUrl));
  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end().catch(() => {});
  }
}

function getDatabaseName(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).pathname.replace(/^\/+|\/+$/g, "") || null;
  } catch {
    return null;
  }
}

export class DatabaseRuntimeService {
  private readonly deps: DatabaseRuntimeDependencies;
  private readonly retryCooldownMs: number;
  private snapshot: DatabaseStatusSnapshot;
  private handlers: DatabaseRuntimeLifecycleHandlers = {};
  private connectPromise: Promise<void> | null = null;
  private lastAttemptAt = 0;
  private pendingReconnectReason: string | null = null;
  private lastConfig: DatabaseRuntimeConfig | null = null;

  constructor(deps?: Partial<DatabaseRuntimeDependencies>) {
    this.retryCooldownMs = deps?.retryCooldownMs ?? 5_000;
    this.snapshot =
      deps?.initialSnapshot ??
      (process.env.VITEST
        ? {
            ok: true,
            state: "connected",
            message: null,
            lastCheckedAt: null,
            lastSuccessAt: null,
          }
        : {
            ok: false,
            state: "disconnected",
            message: "Connecting to PostgreSQL...",
            lastCheckedAt: null,
            lastSuccessAt: null,
          });
    this.deps = {
      resolveConfig: deps?.resolveConfig ?? getEffectiveDatabaseConfig,
      probe: deps?.probe ?? probeDatabase,
      retryCooldownMs: this.retryCooldownMs,
      initialSnapshot: this.snapshot,
    };
  }

  setLifecycleHandlers(handlers: DatabaseRuntimeLifecycleHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    void this.triggerConnect("startup", true);
  }

  async getStatus(options: { triggerReconnect?: boolean } = {}): Promise<DbStatusResponse> {
    if (options.triggerReconnect && this.snapshot.state === "disconnected") {
      void this.triggerConnect("status-poll");
    }
    return this.toStatusResponse();
  }

  async requireDatabase(): Promise<void> {
    if (this.snapshot.state === "connected") {
      return;
    }
    void this.triggerConnect("require-database");
    throw new AppError(
      503,
      ErrorCodes.DATABASE_UNAVAILABLE,
      this.snapshot.message ?? "Server is unable to connect to PostgreSQL database."
    );
  }

  handleOperationalFailure(err: unknown): void {
    if (
      !(err instanceof AppError && err.code === ErrorCodes.DATABASE_UNAVAILABLE) &&
      !isDbConnectionError(err)
    ) {
      return;
    }
    const message =
      err instanceof AppError && err.code === ErrorCodes.DATABASE_UNAVAILABLE
        ? err.message
        : classifyDbConnectionError(err);
    void this.transitionToDisconnected({
      reason: "runtime-failure",
      message,
      source: this.lastConfig?.source ?? "default",
      databaseUrl: this.lastConfig?.databaseUrl ?? "",
    });
  }

  requestReconnect(reason: string): void {
    void this.forceReconnect(reason);
  }

  getSnapshot(): DatabaseStatusSnapshot {
    return { ...this.snapshot };
  }

  private toStatusResponse(): DbStatusResponse {
    return {
      ok: this.snapshot.ok,
      state: this.snapshot.state,
      lastCheckedAt: this.snapshot.lastCheckedAt,
      ...(this.snapshot.message ? { message: this.snapshot.message } : {}),
    };
  }

  private async forceReconnect(reason: string): Promise<void> {
    this.pendingReconnectReason = reason;
    if (this.snapshot.state === "connected") {
      await this.transitionToDisconnected({
        reason,
        message: "Reconnecting to PostgreSQL...",
        source: this.lastConfig?.source ?? "default",
        databaseUrl: this.lastConfig?.databaseUrl ?? "",
      });
    }
    await this.triggerConnect(reason, true);
  }

  private canAttemptConnect(force: boolean): boolean {
    if (force) return true;
    if (this.connectPromise) return false;
    return Date.now() - this.lastAttemptAt >= this.retryCooldownMs;
  }

  private async triggerConnect(reason: string, force = false): Promise<void> {
    if (this.connectPromise) {
      this.pendingReconnectReason = this.pendingReconnectReason ?? reason;
      return this.connectPromise;
    }
    if (!this.canAttemptConnect(force)) {
      return;
    }

    this.lastAttemptAt = Date.now();
    this.connectPromise = this.runConnect(reason).finally(() => {
      this.connectPromise = null;
      const pending = this.pendingReconnectReason;
      this.pendingReconnectReason = null;
      if (pending && pending !== reason) {
        void this.triggerConnect(pending, true);
      }
    });

    return this.connectPromise;
  }

  private async runConnect(reason: string): Promise<void> {
    const config = await this.deps.resolveConfig();
    this.lastConfig = config;

    const databaseName = getDatabaseName(config.databaseUrl);
    if (databaseName === TEST_DB_NAME) {
      await this.transitionToDisconnected({
        ...config,
        reason,
        message:
          'The app cannot use PostgreSQL database "opensprint_test". Configure a non-test database in Settings.',
      });
      return;
    }

    this.transitionToConnecting(config, reason);

    try {
      await this.deps.probe(config.databaseUrl);
      await this.handlers.onConnected?.({
        ...config,
        reason,
        message: null,
      });
      this.snapshot = {
        ok: true,
        state: "connected",
        message: null,
        lastCheckedAt: toIsoNow(),
        lastSuccessAt: toIsoNow(),
      };
      log.info("database.connected", {
        source: config.source,
        reason,
      });
    } catch (err) {
      const message =
        err instanceof AppError && err.code === ErrorCodes.DATABASE_UNAVAILABLE
          ? err.message
          : classifyDbConnectionError(err);
      await this.transitionToDisconnected({
        ...config,
        reason,
        message,
      });
    }
  }

  private transitionToConnecting(config: DatabaseRuntimeConfig, reason: string): void {
    this.snapshot = {
      ...this.snapshot,
      ok: false,
      state: "connecting",
      message: this.snapshot.lastSuccessAt
        ? "Reconnecting to PostgreSQL..."
        : "Connecting to PostgreSQL...",
      lastCheckedAt: toIsoNow(),
    };
    log.info("database.connecting", {
      source: config.source,
      reason,
    });
  }

  private async transitionToDisconnected(context: LifecycleContext): Promise<void> {
    const wasConnected = this.snapshot.state === "connected";
    this.snapshot = {
      ...this.snapshot,
      ok: false,
      state: "disconnected",
      message: context.message,
      lastCheckedAt: toIsoNow(),
    };
    log.warn("database.disconnected", {
      source: context.source,
      reason: context.reason,
      message: context.message,
    });
    if (wasConnected) {
      await this.handlers.onDisconnected?.(context);
    }
  }
}

export const databaseRuntime = new DatabaseRuntimeService();
