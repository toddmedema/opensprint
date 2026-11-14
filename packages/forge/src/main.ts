import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createForgeApp } from "./app.js";
import { parseEncryptionKey } from "./crypto/crypto.js";
import { acquireProcessLock } from "./lock.js";

const dataDir = process.env.FORGE_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".opensprint-forge");
const port = Number(process.env.PORT ?? 4177);
const keyRaw = process.env.TOKEN_ENCRYPTION_KEY;
if (!keyRaw) {
  console.error("Set TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key.");
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const releaseLock = acquireProcessLock(dataDir);
const sessionSecret = readSessionSecret(dataDir);
const clientDir =
  process.env.FORGE_CLIENT_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../forge-web/dist");

const forge = createForgeApp({
  dataDir,
  tokenEncryptionKey: parseEncryptionKey(keyRaw),
  sessionSecret,
  ownerKey: process.env.OPENSPRINT_OWNER_KEY ?? null,
  replayImage: process.env.OPENSPRINT_REPLAY_IMAGE ?? null,
  timer: true,
  clientDir: fs.existsSync(clientDir) ? clientDir : null,
});

const server = forge.app.listen(port, "127.0.0.1", () => {
  console.log(`Open Sprint Forge listening on http://127.0.0.1:${port}`);
});

function shutdown(): void {
  server.close();
  forge.close();
  releaseLock();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function readSessionSecret(dir: string): string {
  if (process.env.OPENSPRINT_SESSION_SECRET) return process.env.OPENSPRINT_SESSION_SECRET;
  const file = path.join(dir, "session-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = Buffer.from(cryptoRandom()).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function cryptoRandom(): Uint8Array {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
