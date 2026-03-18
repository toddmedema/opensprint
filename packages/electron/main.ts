import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execSync, type ChildProcess } from "child_process";
import http from "http";
import net from "net";
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  shell,
  dialog,
  globalShortcut,
  ipcMain,
  type MenuItemConstructorOptions,
} from "electron";
import { buildWindowOptions } from "./window-options";

const APP_NAME = "Open Sprint";
const DEFAULT_BACKEND_PORT = 3100;
const HEALTH_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 30000;
const EXISTING_BACKEND_WAIT_MS = 5000;
const BACKEND_PORT_SEARCH_LIMIT = 20;
const BACKEND_FORCE_KILL_MS = 5000;
const TRAY_REFRESH_MS = 8000;
const TRAY_FETCH_TIMEOUT_MS = 2500;
const TRAY_INIT_RETRY_MS = 600;
const DB_STARTUP_POLL_MS = 500;
const DB_STARTUP_TIMEOUT_MS = 10000;
const SQLITE_RUNTIME_DIR_NAME = "sqlite-runtime";
const SQLITE_RUNTIME_MODULE_NAME = "better-sqlite3";

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendShutdownPromise: Promise<void> | null = null;
let backendLaunchError: Error | null = null;
let backendLogStream: fs.WriteStream | null = null;
let backendLogPath: string | null = null;
let tray: Tray | null = null;
let trayRefreshInterval: ReturnType<typeof setInterval> | null = null;
/** Last successful tray state so we don't show 0 or flicker on fetch errors. */
let lastTrayState: { agentCount: number; title: string } | null = null;
let trayRefreshInFlight: Promise<void> | null = null;
let isQuitting = false;
let quitAfterBackendStop = false;
let backendStartupInProgress = false;
let backendPort = DEFAULT_BACKEND_PORT;

app.setName(APP_NAME);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log(`${APP_NAME} is already running`);
  app.exit(0);
}

function getPaths(): {
  backendDir: string;
  backendEntry: string;
  frontendDist: string;
} {
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    const resourcesPath = process.resourcesPath;
    return {
      backendDir: path.join(resourcesPath, "backend"),
      backendEntry: path.join(resourcesPath, "backend", "dist", "services", "index.cjs"),
      frontendDist: path.join(resourcesPath, "frontend"),
    };
  }
  // When running from dist/main.js, __dirname is packages/electron/dist
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return {
    backendDir: path.join(repoRoot, "packages", "backend"),
    backendEntry: path.join(repoRoot, "packages", "backend", "dist", "index.js"),
    frontendDist: path.join(repoRoot, "packages", "frontend", "dist"),
  };
}

function getAppIconPath(): string | null {
  const isPackaged = app.isPackaged;
  const frontendDir = isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "..", "desktop-resources", "frontend");
  const candidates =
    process.platform === "darwin"
      ? [
          "desktop-icon-mac.png",
          "logo-512x512.png",
          "logo-192x192.png",
          "apple-touch-icon.png",
          "favicon.ico",
        ]
      : ["logo-512x512.png", "logo-192x192.png", "apple-touch-icon.png", "favicon.ico"];
  for (const file of candidates) {
    const fullPath = path.join(frontendDir, file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function applyRuntimeBranding(): string | null {
  const iconPath = getAppIconPath();
  if (!iconPath) return null;
  const iconImage = nativeImage.createFromPath(iconPath);
  if (iconImage.isEmpty()) return null;
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconImage);
  }
  return iconPath;
}

function getTrayIconPaths(): {
  normalPath: string;
  withDotPath: string;
  isTemplate: boolean;
} {
  const isPackaged = app.isPackaged;
  const frontendDir = isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "..", "desktop-resources", "frontend");
  const normal =
    process.platform === "darwin"
      ? path.join(frontendDir, "trayIconTemplate.png")
      : path.join(frontendDir, "favicon-16x16.png");
  const dotPath = path.join(frontendDir, "trayIconTemplateDot.png");
  const normalPath = fs.existsSync(normal) ? normal : path.join(frontendDir, "favicon-16x16.png");
  const withDotPath = fs.existsSync(dotPath) ? dotPath : normalPath;
  return { normalPath, withDotPath, isTemplate: process.platform === "darwin" };
}

function getBackendOrigin(): string {
  return `http://127.0.0.1:${backendPort}`;
}

function getHealthUrl(): string {
  return `${getBackendOrigin()}/health`;
}

function getApiBase(): string {
  return `${getBackendOrigin()}/api/v1`;
}

type DatabaseDialect = "sqlite" | "postgres" | "unknown";

interface DbStartupStatus {
  ok: boolean;
  message: string | null;
  state: string;
  dialect: DatabaseDialect;
}

function fetchJson(url: string, timeoutMs = 500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDbStatus(payload: Record<string, unknown>): Omit<DbStartupStatus, "dialect"> | null {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") {
    return null;
  }
  return {
    ok: obj.ok,
    message: typeof obj.message === "string" ? obj.message : null,
    state: typeof obj.state === "string" ? obj.state : "unknown",
  };
}

function parseDatabaseDialect(payload: Record<string, unknown>): DatabaseDialect {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "unknown";
  }
  const rawDialect = (data as Record<string, unknown>).databaseDialect;
  if (rawDialect === "sqlite" || rawDialect === "postgres") {
    return rawDialect;
  }
  return "unknown";
}

async function waitForDatabaseStartupStatus(
  timeoutMs = DB_STARTUP_TIMEOUT_MS
): Promise<DbStartupStatus> {
  const start = Date.now();
  let lastStatus: Omit<DbStartupStatus, "dialect"> = {
    ok: false,
    message: "Database status did not become ready during startup.",
    state: "unknown",
  };
  let dialect: DatabaseDialect = "unknown";

  while (Date.now() - start < timeoutMs) {
    const [statusPayload, settingsPayload] = await Promise.all([
      fetchJson(`${getApiBase()}/db-status`, 1_500).catch(() => null),
      dialect === "unknown"
        ? fetchJson(`${getApiBase()}/global-settings`, 1_500).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (settingsPayload) {
      dialect = parseDatabaseDialect(settingsPayload);
    }

    if (statusPayload) {
      const parsed = parseDbStatus(statusPayload);
      if (parsed) {
        lastStatus = parsed;
        if (parsed.ok) {
          return { ...parsed, dialect };
        }
      }
    }

    await delay(DB_STARTUP_POLL_MS);
  }

  return { ...lastStatus, dialect };
}

function maybeShowDatabaseStartupDialog(status: DbStartupStatus): void {
  if (status.ok || !app.isPackaged) return;

  const intro =
    status.dialect === "sqlite"
      ? "Open Sprint started, but could not initialize its local SQLite database."
      : "Open Sprint started, but could not connect to the configured database.";
  const guidance =
    status.dialect === "sqlite"
      ? "This is often caused by a missing or incompatible desktop runtime dependency, or a path/permission issue for the database file."
      : "Check your database URL and connectivity in Settings.";
  const reason = status.message ?? "Unknown database startup error.";
  const detail =
    `${intro}\n\nReason: ${reason}\n\n${guidance}` +
    (backendLogPath ? `\n\nBackend log: ${backendLogPath}` : "");

  loadBootScreen(`Database unavailable: ${reason}`);
  dialog.showErrorBox("Database Setup Error", detail);
}

function probeDesktopBackend(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(getBackendOrigin(), (res) => {
      // Desktop backend serves the bundled frontend at "/" (HTTP 200).
      // Dev backend returns 404 at "/", which should not be reused by Electron.
      const desktopReady = res.statusCode === 200;
      res.resume();
      finish(desktopReady);
    });
    req.on("error", () => finish(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
  });
}

function probeBackendHealth(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(getHealthUrl(), (res) => {
      const healthy = res.statusCode === 200;
      res.resume();
      finish(healthy);
    });
    req.on("error", () => finish(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
  });
}

async function waitForExistingDesktopBackend(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeDesktopBackend()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return probeDesktopBackend();
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, "127.0.0.1");
  });
}

async function findAvailableBackendPort(): Promise<number | null> {
  for (let offset = 1; offset <= BACKEND_PORT_SEARCH_LIMIT; offset += 1) {
    const candidate = DEFAULT_BACKEND_PORT + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForBackend(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let done = false;
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      reject(error);
    };
    const succeed = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const isExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    function poll(): void {
      if (isExited()) {
        fail(
          backendLaunchError ??
            new Error(
              child.signalCode
                ? `Backend exited before startup (signal ${child.signalCode})`
                : `Backend exited before startup (code ${child.exitCode ?? "unknown"})`
            )
        );
        return;
      }
      const req = http.get(getHealthUrl(), (res) => {
        if (res.statusCode === 200) {
          succeed();
          return;
        }
        tryNext();
      });
      req.on("error", tryNext);
      req.setTimeout(5000, () => {
        req.destroy();
        tryNext();
      });
    }
    function tryNext(): void {
      if (done) return;
      if (isExited()) {
        fail(
          backendLaunchError ??
            new Error(
              child.signalCode
                ? `Backend exited before startup (signal ${child.signalCode})`
                : `Backend exited before startup (code ${child.exitCode ?? "unknown"})`
            )
        );
        return;
      }
      if (Date.now() - start >= HEALTH_TIMEOUT_MS) {
        fail(
          backendLaunchError ??
            new Error("Backend failed to start within 30s (health check never became ready)")
        );
        return;
      }
      setTimeout(poll, HEALTH_POLL_MS);
    }
    poll();
  });
}

function ensureBackendLogStream(): fs.WriteStream | null {
  if (backendLogStream) return backendLogStream;
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    backendLogPath = path.join(logDir, "backend.log");
    backendLogStream = fs.createWriteStream(backendLogPath, { flags: "a" });
    backendLogStream.write(`\n[${new Date().toISOString()}] Backend launch attempt\n`);
    backendLogStream.on("error", (err) => {
      console.error("Backend log stream error:", err);
      backendLogStream = null;
    });
    return backendLogStream;
  } catch (err) {
    console.error("Could not initialize backend log file:", err);
    return null;
  }
}

function closeBackendLogStream(): void {
  if (!backendLogStream) return;
  try {
    backendLogStream.end();
  } catch {
    // ignore
  }
  backendLogStream = null;
}

function isDirectory(candidate: string): boolean {
  if (!candidate.trim()) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

type ParsedNodeVersion = {
  major: number;
  minor: number;
  patch: number;
};

function parseNodeVersionFromDirName(name: string): ParsedNodeVersion | null {
  const match = name.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareNodeVersionDesc(a: ParsedNodeVersion, b: ParsedNodeVersion): number {
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  return b.patch - a.patch;
}

function getNvmNodeBinPaths(homeDir: string): string[] {
  const nvmDir = process.env.NVM_DIR?.trim() || path.join(homeDir, ".nvm");
  const bins: string[] = [];
  const currentBin = path.join(nvmDir, "current", "bin");

  const versionsDir = path.join(nvmDir, "versions", "node");
  try {
    const versionBins = fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const versionBin = path.join(versionsDir, entry.name, "bin");
        return {
          versionBin,
          parsedVersion: parseNodeVersionFromDirName(entry.name),
        };
      })
      .filter((item) => isDirectory(item.versionBin))
      .sort((a, b) => {
        if (a.parsedVersion && b.parsedVersion) {
          return compareNodeVersionDesc(a.parsedVersion, b.parsedVersion);
        }
        if (a.parsedVersion) return -1;
        if (b.parsedVersion) return 1;
        return a.versionBin.localeCompare(b.versionBin);
      });

    for (const item of versionBins) {
      bins.push(item.versionBin);
    }
  } catch {
    // No nvm directory on this machine.
  }

  // Keep nvm "current" available, but after explicit version bins so oldest versions do not shadow newer.
  if (isDirectory(currentBin)) {
    bins.push(currentBin);
  }

  return bins;
}

function buildBackendPath(existingPath: string): string {
  const pathDelimiter = process.platform === "win32" ? ";" : ":";
  const homeDir = os.homedir();
  const preferredPathEntries = [
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".cursor", "bin"),
    path.join(homeDir, ".volta", "bin"),
    path.join(homeDir, ".fnm", "current", "bin"),
    path.join(homeDir, ".asdf", "shims"),
    path.join(homeDir, ".mise", "shims"),
    path.join(homeDir, ".nodenv", "shims"),
    ...getNvmNodeBinPaths(homeDir),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(isDirectory);

  return [
    ...new Set([
      ...preferredPathEntries,
      ...existingPath.split(pathDelimiter).filter((entry) => entry.trim().length > 0),
    ]),
  ].join(pathDelimiter);
}

const PREREQ_CHECK_TIMEOUT_MS = 8000;

interface PrerequisitesCheckResult {
  missing: string[];
  path?: string;
  platform: string;
}

/** On Windows, read PATH from registry (user + machine) so we see newly installed tools without restart. */
function getWindowsPathFromRegistry(): string | undefined {
  try {
    const userPath = execSync(
      "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path', 'User')\"",
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    ).trim();
    const machinePath = execSync(
      "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path', 'Machine')\"",
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    ).trim();
    const parts = [userPath, machinePath, process.env.PATH].filter(Boolean);
    return parts.join(";");
  } catch {
    return undefined;
  }
}

/** Run prerequisite check in a fresh shell (login shell on Unix) so we see newly installed tools. */
function checkPrerequisitesFresh(): Promise<PrerequisitesCheckResult> {
  const platform = process.platform;
  const result: PrerequisitesCheckResult = { missing: [], platform };

  if (platform === "win32") {
    const freshPath = getWindowsPathFromRegistry();
    result.path = freshPath ?? process.env.PATH;
    const env = freshPath ? { ...process.env, PATH: freshPath } : process.env;
    try {
      execSync("git --version", { encoding: "utf8", timeout: 5000, windowsHide: true, env });
    } catch {
      result.missing.push("Git");
    }
    try {
      execSync("node --version", { encoding: "utf8", timeout: 5000, windowsHide: true, env });
    } catch {
      result.missing.push("Node.js");
    }
    return Promise.resolve(result);
  }

  // Unix: use login shell so we pick up profile-updated PATH (e.g. after installing nvm/node).
  return new Promise((resolve) => {
    const script =
      'echo "__PATH__$PATH"; (git --version 2>/dev/null && node --version 2>/dev/null) || true';
    const child = spawn("/bin/sh", ["-l", "-c", script], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    const timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      result.missing = ["Git", "Node.js"];
      resolve(result);
    }, PREREQ_CHECK_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timeoutId);
      const pathMatch = stdout.match(/__PATH__(.*?)(?:\n|$)/s);
      if (pathMatch && pathMatch[1]) {
        result.path = pathMatch[1].trim();
      }
      const hasGit = /git version/i.test(stdout) || /git version/i.test(stderr);
      const hasNode = /v\d+\.\d+\.\d+/.test(stdout) || /v\d+\.\d+\.\d+/.test(stderr);
      if (!hasGit) result.missing.push("Git");
      if (!hasNode) result.missing.push("Node.js");
      resolve(result);
    };
    child.on("error", () => {
      result.missing = ["Git", "Node.js"];
      finish();
    });
    child.on("close", finish);
  });
}

function startBackend(pathOverride?: string): ChildProcess {
  const { backendDir, backendEntry, frontendDist } = getPaths();
  backendLaunchError = null;
  const backendLog = app.isPackaged ? ensureBackendLogStream() : null;
  const normalizedPath =
    pathOverride !== undefined && pathOverride !== ""
      ? pathOverride
      : buildBackendPath(process.env.PATH ?? "");
  const sqliteRuntimeDir = path.join(backendDir, SQLITE_RUNTIME_DIR_NAME);
  const sqliteRuntimeModulePath = path.join(
    sqliteRuntimeDir,
    "node_modules",
    SQLITE_RUNTIME_MODULE_NAME
  );
  const hasSqliteRuntimeFallback = fs.existsSync(sqliteRuntimeModulePath);
  if (app.isPackaged && !hasSqliteRuntimeFallback) {
    console.warn(
      "[startup] SQLite fallback runtime module is missing",
      JSON.stringify({ sqliteRuntimeModulePath })
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(backendPort),
    OPENSPRINT_DESKTOP: "1",
    OPENSPRINT_FRONTEND_DIST: frontendDist,
    PATH: normalizedPath,
    // Use Electron's embedded Node runtime so packaged apps do not depend on PATH.
    ELECTRON_RUN_AS_NODE: "1",
    OPENSPRINT_SQLITE_MODULE_PATH: sqliteRuntimeModulePath,
  };
  const child = spawn(process.execPath, [backendEntry], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      if (!app.isPackaged) {
        process.stdout.write(data);
      }
      if (backendLog) {
        backendLog.write(data);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      if (!app.isPackaged) {
        process.stderr.write(data);
      }
      if (backendLog) {
        backendLog.write(data);
      }
    });
  }
  child.on("error", (err: Error) => {
    backendLaunchError = new Error(`Backend process error: ${err.message}`);
    console.error("Backend process error:", err);
  });
  child.on("exit", (code, signal) => {
    const exitedActiveBackend = backendProcess === child;
    if (exitedActiveBackend) {
      backendProcess = null;
      backendShutdownPromise = null;
      closeBackendLogStream();
    }
    if (!isQuitting && code !== 0) {
      backendLaunchError = new Error(`Backend exited with code ${code}`);
    } else if (!isQuitting && signal) {
      backendLaunchError = new Error(`Backend exited with signal ${signal}`);
    }
    if (isQuitting) return;
    if (!exitedActiveBackend) return;
    if (code != null && code !== 0) {
      console.error("Backend exited with code", code);
      if (backendStartupInProgress) {
        return;
      }
      dialog.showErrorBox(
        "Backend Error",
        "The backend process crashed. The app will now quit." +
          (backendLogPath ? `\n\nBackend log: ${backendLogPath}` : "")
      );
      app.exit(1);
    }
    if (signal) {
      console.error("Backend killed with signal", signal);
    }
  });
  return child;
}

function renderBootHtml(statusText: string): string {
  const escaped = statusText
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        min-height: 100vh;
        overflow: hidden;
        box-sizing: border-box;
        background: radial-gradient(circle at top, #1e293b 0%, #020617 60%);
        color: #e2e8f0;
      }
      *, *::before, *::after { box-sizing: inherit; }
      .boot {
        height: 100%;
        min-height: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        overflow: hidden;
      }
      .card {
        width: min(420px, 100%);
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.75);
        padding: 24px;
        backdrop-filter: blur(3px);
      }
      .title {
        margin: 0 0 8px;
        font-size: 20px;
        font-weight: 600;
      }
      .status {
        margin: 0;
        color: #cbd5e1;
        font-size: 14px;
      }
      .row {
        margin-top: 16px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(148, 163, 184, 0.45);
        border-top-color: #38bdf8;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <main class="boot">
      <section class="card">
        <h1 class="title">${APP_NAME}</h1>
        <p class="status">${escaped}</p>
        <div class="row">
          <div class="spinner" aria-hidden="true"></div>
          <p class="status">Preparing local services...</p>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function loadBootScreen(statusText: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = renderBootHtml(statusText);
  const bootUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  void mainWindow.loadURL(bootUrl);
}

function createWindow(): void {
  const appIconPath = getAppIconPath();
  const windowOptions = buildWindowOptions({
    appName: APP_NAME,
    iconPath: appIconPath,
    preloadPath: path.join(__dirname, "preload.js"),
    platform: process.platform,
  });
  mainWindow = new BrowserWindow(windowOptions);
  if (process.platform === "win32" && mainWindow) {
    mainWindow.on("maximize", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("window-maximized");
    });
    mainWindow.on("unmaximize", () => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("window-unmaximized");
    });
  }
  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.webContents.on(
    "found-in-page",
    (
      _e: Electron.Event,
      result: {
        requestId: number;
        activeMatchOrdinal: number;
        matches: number;
        finalUpdate: boolean;
      }
    ) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("find-result", result);
      }
    }
  );
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== getBackendOrigin()) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  loadBootScreen("Starting backend...");
  mainWindow.on("close", (e) => {
    if (isQuitting) {
      return;
    }
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

function runRefreshTrayMenu(): Promise<void> {
  if (!tray || tray.isDestroyed()) return Promise.resolve();
  const { normalPath, withDotPath, isTemplate } = getTrayIconPaths();
  return Promise.all([
    fetchJson(`${getApiBase()}/agents/active-count`, TRAY_FETCH_TIMEOUT_MS).then((r) => r).catch(() => null),
    fetchJson(`${getApiBase()}/notifications/pending-count`, TRAY_FETCH_TIMEOUT_MS).then((r) => r).catch(() => null),
    fetchJson(`${getApiBase()}/global-settings`, TRAY_FETCH_TIMEOUT_MS).then((r) => r).catch(() => null),
  ]).then(([agentsRes, notifRes, settingsRes]) => {
    if (!tray || tray.isDestroyed()) return;
    const fetchOk = agentsRes != null && agentsRes.data != null;
    const fetchedCount = (agentsRes?.data as { count?: number } | undefined)?.count ?? 0;
    const agentCount = fetchOk ? fetchedCount : (lastTrayState?.agentCount ?? 0);
    if (fetchOk) {
      lastTrayState = lastTrayState ?? { agentCount: 0, title: "" };
      lastTrayState.agentCount = fetchedCount;
    }
    const pendingCount = (notifRes?.data as { count?: number } | undefined)?.count ?? 0;
    const showDot =
      (settingsRes?.data as { showNotificationDotInMenuBar?: boolean } | undefined)
        ?.showNotificationDotInMenuBar !== false;
    const useDotIcon = pendingCount > 0 && showDot;
    const iconPath = useDotIcon ? withDotPath : normalPath;
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) img = nativeImage.createFromPath(normalPath);
    if (isTemplate && !img.isEmpty()) img.setTemplateImage(true);
    tray.setImage(img);
    // On macOS, force multiple setImage calls so the menu bar status item redraws and the
    // notification dot is removed immediately without requiring app focus.
    if (process.platform === "darwin" && tray && !tray.isDestroyed()) {
      const applyIcon = (): void => {
        if (!tray || tray.isDestroyed()) return;
        const imgNext = nativeImage.createFromPath(iconPath);
        const imgToUse = imgNext.isEmpty() ? nativeImage.createFromPath(normalPath) : imgNext;
        if (isTemplate && !imgToUse.isEmpty()) imgToUse.setTemplateImage(true);
        tray!.setImage(imgToUse);
      };
      setImmediate(applyIcon);
      // When switching to no-dot, a delayed third setImage helps macOS reliably clear the dot.
      if (!useDotIcon) {
        setTimeout(applyIcon, 100);
      }
    }
    if (process.platform === "darwin") {
      const showCount =
        (settingsRes?.data as { showRunningAgentCountInMenuBar?: boolean } | undefined)
          ?.showRunningAgentCountInMenuBar !== false;
      const title = showCount
        ? agentCount === 0
          ? ""
          : agentCount > 9
            ? "9+"
            : String(agentCount)
        : "";
      if (title !== (lastTrayState?.title ?? null)) {
        tray.setTitle(title, { fontType: "monospacedDigit" });
        if (lastTrayState) lastTrayState.title = title;
        else lastTrayState = { agentCount, title };
      }
    }
    const menu = Menu.buildFromTemplate([
      { label: `${agentCount} agents running`, enabled: false },
      { type: "separator" },
      {
        label: `Show ${APP_NAME}`,
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]);
    tray.setContextMenu(menu);
  });
}

function refreshTrayMenu(): Promise<void> {
  if (!tray || tray.isDestroyed()) return Promise.resolve();
  if (trayRefreshInFlight) {
    return trayRefreshInFlight.then(() => {
      if (tray && !tray.isDestroyed()) return runRefreshTrayMenu();
    });
  }
  trayRefreshInFlight = runRefreshTrayMenu().finally(() => {
    trayRefreshInFlight = null;
  });
  return trayRefreshInFlight;
}

function createTray(): void {
  const { normalPath, isTemplate } = getTrayIconPaths();
  let img = nativeImage.createFromPath(normalPath);
  if (img.isEmpty())
    img = nativeImage.createFromPath(path.join(path.dirname(normalPath), "favicon-16x16.png"));
  if (isTemplate && !img.isEmpty()) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  if (process.platform === "darwin") tray.setTitle("", { fontType: "monospacedDigit" });
  refreshTrayMenu();
  setTimeout(() => refreshTrayMenu(), TRAY_INIT_RETRY_MS);
  tray.on("click", () => {
    if (process.platform === "darwin") {
      refreshTrayMenu().then(() => {
        if (tray && !tray.isDestroyed()) tray.popUpContextMenu();
      });
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function focusAndOpenFindBar(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("open-find-bar");
  }
}

function sendNavigateHelp(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("navigate-help");
  }
}

function sendNavigateSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("navigate-settings");
  }
}

function setApplicationMenu(): void {
  if (process.platform === "win32") {
    Menu.setApplicationMenu(null);
    return;
  }
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "Settings…",
                accelerator: "CommandOrControl+,",
                click: sendNavigateSettings,
              },
              { label: "Help", click: sendNavigateHelp },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { label: "Find", accelerator: "CommandOrControl+F", click: focusAndOpenFindBar },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        ...(!isMac
          ? [{ label: "Settings", click: sendNavigateSettings }, { type: "separator" as const }]
          : []),
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      role: "help" as const,
      submenu: [{ label: "Open Help", click: sendNavigateHelp }],
    },
  ] as MenuItemConstructorOptions[];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killBackend(): Promise<void> {
  if (!backendProcess) return Promise.resolve();
  if (backendShutdownPromise) return backendShutdownPromise;

  const proc = backendProcess;
  const pid = proc.pid;
  backendShutdownPromise = new Promise((resolve) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (backendProcess === proc) {
        backendProcess = null;
        closeBackendLogStream();
      }
      backendShutdownPromise = null;
      resolve();
    };

    if (!pid || proc.exitCode !== null || proc.signalCode !== null || !isProcessAlive(pid)) {
      finish();
      return;
    }

    const onExit = () => {
      finish();
    };
    proc.once("exit", onExit);

    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      if (!isProcessAlive(pid)) {
        proc.removeListener("exit", onExit);
        finish();
      }
    }, BACKEND_FORCE_KILL_MS);
  });

  return backendShutdownPromise;
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function setupSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["clipboard-read", "clipboard-sanitized-write"];
    callback(allowed.includes(permission));
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' " +
            getBackendOrigin() +
            "; script-src 'self'; connect-src 'self' ws://127.0.0.1:" +
            backendPort +
            "; style-src 'self' 'unsafe-inline'; img-src 'self' data: " +
            getBackendOrigin(),
        ],
      },
    });
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) {
    return;
  }

  setupSessionSecurity();
  applyRuntimeBranding();
  createWindow();
  setApplicationMenu();

  ipcMain.handle(
    "find-in-page",
    (
      event: Electron.IpcMainInvokeEvent,
      text: string,
      options?: { forward?: boolean; findNext?: boolean; caseSensitive?: boolean }
    ) => {
      const wc = event.sender;
      if (wc && !wc.isDestroyed()) wc.findInPage(text, options ?? {});
    }
  );
  ipcMain.handle(
    "stop-find-in-page",
    (
      event: Electron.IpcMainInvokeEvent,
      action: "clearSelection" | "keepSelection" | "activateSelection"
    ) => {
      const wc = event.sender;
      if (wc && !wc.isDestroyed()) wc.stopFindInPage(action);
    }
  );

  ipcMain.handle("refresh-tray", () => {
    return refreshTrayMenu();
  });

  ipcMain.handle("window-minimize", (event: Electron.IpcMainInvokeEvent) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.minimize();
  });
  ipcMain.handle("window-maximize", (event: Electron.IpcMainInvokeEvent) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
    }
  });
  ipcMain.handle("window-close", (event: Electron.IpcMainInvokeEvent) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.close();
  });
  ipcMain.handle("window-is-maximized", (event: Electron.IpcMainInvokeEvent) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return w && !w.isDestroyed() && w.isMaximized();
  });

  ipcMain.handle("restart-app", () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("prerequisites:checkFresh", async (): Promise<PrerequisitesCheckResult> => {
    return checkPrerequisitesFresh();
  });

  ipcMain.handle(
    "backend:restartWithPath",
    async (
      _event: Electron.IpcMainInvokeEvent,
      pathOverride: string | undefined
    ): Promise<void> => {
      await killBackend();
      backendProcess = startBackend(pathOverride ?? undefined);
      await waitForBackend(backendProcess);
    }
  );

  globalShortcut.register("CommandOrControl+F", focusAndOpenFindBar);

  backendPort = DEFAULT_BACKEND_PORT;
  let backendReady = false;
  let startupError: unknown = null;

  if (await probeDesktopBackend()) {
    backendReady = true;
    loadBootScreen("Connected to an existing backend service.");
  } else {
    if (await probeBackendHealth()) {
      const fallbackPort = await findAvailableBackendPort();
      if (fallbackPort !== null) {
        backendPort = fallbackPort;
        loadBootScreen(`Primary backend port is busy. Retrying on port ${fallbackPort}...`);
      }
    }

    backendStartupInProgress = true;
    backendProcess = startBackend();
    try {
      await waitForBackend(backendProcess);
      backendLaunchError = null;
      backendReady = true;
    } catch (err) {
      startupError = err;
      const connectedToExistingBackend =
        await waitForExistingDesktopBackend(EXISTING_BACKEND_WAIT_MS);
      if (connectedToExistingBackend) {
        backendLaunchError = null;
        backendReady = true;
        loadBootScreen("Connected to an existing backend service.");
      } else {
        await killBackend();
        const fallbackPort = await findAvailableBackendPort();
        if (fallbackPort !== null && fallbackPort !== backendPort) {
          backendPort = fallbackPort;
          loadBootScreen(`Primary backend port is busy. Retrying on port ${fallbackPort}...`);
          backendProcess = startBackend();
          try {
            await waitForBackend(backendProcess);
            backendLaunchError = null;
            backendReady = true;
          } catch (retryErr) {
            startupError = retryErr;
            await killBackend();
          }
        }
      }
    } finally {
      backendStartupInProgress = false;
    }
  }

  if (!backendReady) {
    const message =
      startupError instanceof Error
        ? startupError.message
        : String(startupError ?? "unknown error");
    console.error(message);
    loadBootScreen(`Backend failed to start: ${message}`);
    dialog.showErrorBox(
      "Backend Failed to Start",
      `The backend could not start: ${message}` +
        (backendLogPath ? `\n\nBackend log: ${backendLogPath}` : "")
    );
    app.exit(1);
    return;
  }

  loadBootScreen("Checking database connectivity...");
  const dbStartupStatus = await waitForDatabaseStartupStatus();
  maybeShowDatabaseStartupDialog(dbStartupStatus);

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(getBackendOrigin());
  }
  createTray();
  trayRefreshInterval = setInterval(refreshTrayMenu, TRAY_REFRESH_MS);
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (trayRefreshInterval) {
    clearInterval(trayRefreshInterval);
    trayRefreshInterval = null;
  }

  if (quitAfterBackendStop) return;
  if (!backendProcess) {
    closeBackendLogStream();
    return;
  }

  event.preventDefault();
  quitAfterBackendStop = true;
  void killBackend().finally(() => {
    app.quit();
  });
});
