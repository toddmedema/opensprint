import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
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

const APP_NAME = "Open Sprint";
const BACKEND_PORT = 3100;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/health`;
const HEALTH_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 30000;
const BACKEND_FORCE_KILL_MS = 5000;
const API_BASE = `${BACKEND_ORIGIN}/api/v1`;
const TRAY_REFRESH_MS = 10000;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendShutdownPromise: Promise<void> | null = null;
let backendLaunchError: Error | null = null;
let tray: Tray | null = null;
let trayRefreshInterval: ReturnType<typeof setInterval> | null = null;
let isQuitting = false;
let quitAfterBackendStop = false;

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
      const req = http.get(HEALTH_URL, (res) => {
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

function startBackend(): ChildProcess {
  const { backendDir, backendEntry, frontendDist } = getPaths();
  backendLaunchError = null;
  const pathDelimiter = process.platform === "win32" ? ";" : ":";
  const existingPath = process.env.PATH ?? "";
  const preferredPathEntries = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cursor", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const normalizedPath = [
    ...new Set([
      ...preferredPathEntries.filter((entry) => entry.trim().length > 0),
      ...existingPath.split(pathDelimiter).filter((entry) => entry.trim().length > 0),
    ]),
  ].join(pathDelimiter);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSPRINT_DESKTOP: "1",
    OPENSPRINT_FRONTEND_DIST: frontendDist,
    PATH: normalizedPath,
    // Use Electron's embedded Node runtime so packaged apps do not depend on PATH.
    ELECTRON_RUN_AS_NODE: "1",
  };
  const child = spawn(process.execPath, [backendEntry], {
    cwd: backendDir,
    env,
    stdio: app.isPackaged ? "ignore" : ["inherit", "pipe", "pipe"],
  });
  if (!app.isPackaged && child.stdout) {
    child.stdout.on("data", (data: Buffer) => process.stdout.write(data));
  }
  if (!app.isPackaged && child.stderr) {
    child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
  }
  child.on("error", (err: Error) => {
    backendLaunchError = new Error(`Backend process error: ${err.message}`);
    console.error("Backend process error:", err);
  });
  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
      backendShutdownPromise = null;
    }
    if (!isQuitting && code !== 0) {
      backendLaunchError = new Error(`Backend exited with code ${code}`);
    } else if (!isQuitting && signal) {
      backendLaunchError = new Error(`Backend exited with signal ${signal}`);
    }
    if (isQuitting) return;
    if (code != null && code !== 0) {
      console.error("Backend exited with code", code);
      dialog.showErrorBox(
        "Backend Error",
        "The backend process crashed. The app will now quit."
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
        background: radial-gradient(circle at top, #1e293b 0%, #020617 60%);
        color: #e2e8f0;
      }
      .boot {
        height: 100%;
        display: grid;
        place-items: center;
        padding: 24px;
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    icon: appIconPath || undefined,
    show: false,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.webContents.on(
    "found-in-page",
    (
      _e: Electron.Event,
      result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
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
      if (parsed.origin !== BACKEND_ORIGIN) {
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

function refreshTrayMenu(): Promise<void> {
  if (!tray || tray.isDestroyed()) return Promise.resolve();
  const { normalPath, withDotPath, isTemplate } = getTrayIconPaths();
  return Promise.all([
    fetchJson(`${API_BASE}/agents/active-count`).catch(() => ({ data: { count: 0 } })),
    fetchJson(`${API_BASE}/notifications/pending-count`).catch(() => ({ data: { count: 0 } })),
    fetchJson(`${API_BASE}/global-settings`).catch(() => ({
      data: { showNotificationDotInMenuBar: true },
    })),
  ]).then(([agentsRes, notifRes, settingsRes]) => {
    if (!tray || tray.isDestroyed()) return;
    const agentCount = (agentsRes?.data as { count?: number } | undefined)?.count ?? 0;
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
      tray.setTitle(title, { fontType: "monospacedDigit" });
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

function setApplicationMenu(): void {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
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
        ...(process.platform === "darwin"
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
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
      }
      backendShutdownPromise = null;
      resolve();
    };

    if (
      !pid ||
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      !isProcessAlive(pid)
    ) {
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
            BACKEND_ORIGIN +
            "; script-src 'self'; connect-src 'self' ws://127.0.0.1:" +
            BACKEND_PORT +
            "; style-src 'self' 'unsafe-inline'; img-src 'self' data: " +
            BACKEND_ORIGIN,
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
    (event: Electron.IpcMainInvokeEvent, action: "clearSelection" | "keepSelection" | "activateSelection") => {
      const wc = event.sender;
      if (wc && !wc.isDestroyed()) wc.stopFindInPage(action);
    }
  );

  ipcMain.handle("refresh-tray", () => {
    return refreshTrayMenu();
  });

  globalShortcut.register("CommandOrControl+F", focusAndOpenFindBar);

  backendProcess = startBackend();
  try {
    await waitForBackend(backendProcess);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    loadBootScreen(`Backend failed to start: ${message}`);
    await killBackend();
    dialog.showErrorBox(
      "Backend Failed to Start",
      `The backend could not start: ${message}`
    );
    app.exit(1);
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(BACKEND_ORIGIN);
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
  if (!backendProcess) return;

  event.preventDefault();
  quitAfterBackendStop = true;
  void killBackend().finally(() => {
    app.quit();
  });
});
