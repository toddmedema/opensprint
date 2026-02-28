/**
 * Postgres bootstrap: ensures local Docker Postgres is running before server boot.
 * When databaseUrl points to localhost/127.0.0.1, runs docker compose up -d and
 * polls until Postgres accepts connections (max 60s). For remote URLs, skips.
 */
import { exec } from "child_process";
import { promisify } from "util";
import net from "net";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";

const execAsync = promisify(exec);
const log = createLogger("postgres-bootstrap");

const POLL_INTERVAL_MS = 1000;
const MAX_WAIT_MS =
  process.env.OPENSPRINT_POSTGRES_MAX_WAIT_MS != null
    ? parseInt(process.env.OPENSPRINT_POSTGRES_MAX_WAIT_MS, 10)
    : 60_000;

/**
 * Returns true if the database URL host is local (localhost or 127.0.0.1).
 */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const host = (parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Check if Postgres is accepting connections at the given host:port.
 */
function isPostgresAcceptingConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Find the directory containing docker-compose.yml (project root).
 * Walks up from cwd.
 */
function findComposeDir(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const composePath = path.join(dir, "docker-compose.yml");
    if (fs.existsSync(composePath)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Run docker compose up -d. Prefers "docker compose" (V2) over "docker-compose" (V1).
 */
async function runDockerComposeUp(composeDir: string): Promise<void> {
  const opts = { cwd: composeDir };
  try {
    await execAsync("docker compose up -d", opts);
  } catch {
    try {
      await execAsync("docker-compose up -d", opts);
    } catch (err) {
      throw new Error(
        `Failed to start Docker Postgres. Run "docker compose up -d" from the project root. ${(err as Error).message}`
      );
    }
  }
}

/**
 * Ensure Docker Postgres is running when databaseUrl points to localhost/127.0.0.1.
 * Runs docker compose up -d, polls until Postgres accepts connections (max 60s),
 * logs "Waiting for Docker Postgres..." while waiting.
 * For remote URLs, returns immediately without doing anything.
 */
export async function ensureDockerPostgresRunning(databaseUrl: string): Promise<void> {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    return;
  }

  let host: string;
  let port: number;
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname || "localhost";
    port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  } catch {
    return;
  }

  // Quick check: already accepting connections?
  if (await isPostgresAcceptingConnections(host, port)) {
    return;
  }

  const composeDir = findComposeDir();
  if (!composeDir) {
    throw new Error(
      "docker-compose.yml not found. Run from project root or ensure docker-compose.yml exists."
    );
  }

  log.info("Starting Docker Postgres...");
  await runDockerComposeUp(composeDir);

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    log.info("Waiting for Docker Postgres...");
    if (await isPostgresAcceptingConnections(host, port)) {
      log.info("Docker Postgres is ready");
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Docker Postgres did not become ready within ${MAX_WAIT_MS / 1000}s. Check "docker compose logs postgres".`
  );
}
