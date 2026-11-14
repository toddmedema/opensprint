import path from "node:path";
import { decryptString, encryptString } from "./crypto/crypto.js";
import type { CredentialSecret, ProjectRecord } from "./domain.js";
import { Engine } from "./engine/engine.js";
import { EvolveService } from "./evolve/evolve.js";
import { dockerReplayRunner, type ReplayRunner } from "./evolve/replay.js";
import { GateService } from "./gate/gate.js";
import { createHttp } from "./http/http.js";
import { NotifyHub } from "./notify/hub.js";
import { spawnProcess, type ProcessSpawner } from "./run/spawn.js";
import { openDatabase } from "./db/database.js";
import { ForgeStore } from "./store/store.js";
import { setTreeWritable } from "./workspace/freeze.js";
import { GitWorkspace } from "./workspace/git.js";

export interface ForgeOptions {
  dataDir: string;
  tokenEncryptionKey: Buffer;
  sessionSecret: string;
  ownerKey: string | null;
  replayImage?: string | null;
  timer?: boolean;
  clientDir?: string | null;
  spawn?: ProcessSpawner;
  replayRunner?: ReplayRunner;
}

export function createForgeApp(options: ForgeOptions) {
  if (options.tokenEncryptionKey.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes.");
  }
  const database = openDatabase(path.join(options.dataDir, "forge.sqlite"));
  const store = new ForgeStore(database);
  const workspace = new GitWorkspace(options.dataDir);
  const notify = new NotifyHub();
  const gate = new GateService(store);
  const replayImage = options.replayImage ?? null;
  const evolve = new EvolveService(
    store,
    options.replayRunner ?? dockerReplayRunner(replayImage),
    options.ownerKey,
    replayImage
  );
  const engine = new Engine({
    store,
    workspace,
    gate,
    notify,
    spawn: options.spawn ?? spawnProcess,
    dataDir: options.dataDir,
    readCredential: (project) => readCredential(store, options.tokenEncryptionKey, project),
  });
  const app = createHttp({
    store,
    engine,
    evolve,
    notify,
    workspace,
    sessionSecret: options.sessionSecret,
    ownerKey: options.ownerKey,
    encrypt: (text) => encryptString(options.tokenEncryptionKey, text),
    clientDir: options.clientDir ?? null,
  });
  if (options.timer !== false) engine.startTimer();
  return {
    app,
    engine,
    store,
    close() {
      engine.close();
      setTreeWritable(options.dataDir, true);
    },
    abandon() {
      engine.abandon();
      setTreeWritable(options.dataDir, true);
    },
  };
}

function readCredential(store: ForgeStore, key: Buffer, project: ProjectRecord): CredentialSecret {
  if (!project.credentialId) return { type: "none" };
  const row = store.credentialById(project.credentialId);
  if (!row) return { type: "none" };
  return JSON.parse(decryptString(key, row.ciphertext)) as CredentialSecret;
}
