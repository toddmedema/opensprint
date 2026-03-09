"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");

const APP_NAME = "Open Sprint";
const BACKEND_PORT = 3100;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/health`;
const HEALTH_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 30000;
const API_BASE = `http://127.0.0.1:${BACKEND_PORT}/api/v1`;
const TRAY_REFRESH_MS = 10000;

let mainWindow = null;
let backendProcess = null;
let tray = null;
let isQuitting = false;

app.setName(APP_NAME);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log(`${APP_NAME} is already running`);
  app.exit(0);
}

function getPaths() {
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    const resourcesPath = process.resourcesPath;
    return {
      backendDir: path.join(resourcesPath, "backend"),
      backendEntry: path.join(resourcesPath, "backend", "dist", "index.js"),
      frontendDist: path.join(resourcesPath, "frontend"),
    };
  }
  const repoRoot = path.resolve(__dirname, "..", "..");
  return {
    backendDir: path.join(repoRoot, "packages", "backend"),
    backendEntry: path.join(repoRoot, "packages", "backend", "dist", "index.js"),
    frontendDist: path.join(repoRoot, "packages", "frontend", "dist"),
  };
}

function getAppIconPath() {
  const isPackaged = app.isPackaged;
  const frontendDir = isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "desktop-resources", "frontend");
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

function applyRuntimeBranding() {
  const iconPath = getAppIconPath();
  if (!iconPath) return null;
  const iconImage = nativeImage.createFromPath(iconPath);
  if (iconImage.isEmpty()) return null;
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconImage);
  }
  return iconPath;
}

function getTrayIconPaths() {
  const isPackaged = app.isPackaged;
  const frontendDir = isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "desktop-resources", "frontend");
  const normal =
    process.platform === "darwin"
      ? path.join(frontendDir, "trayIconTemplate.png")
      : path.join(frontendDir, "favicon-16x16.png");
  const dotPath = path.join(frontendDir, "trayIconTemplateDot.png");
  const normalPath = fs.existsSync(normal) ? normal : path.join(frontendDir, "favicon-16x16.png");
  const withDotPath = fs.existsSync(dotPath) ? dotPath : normalPath;
  return { normalPath, withDotPath, isTemplate: process.platform === "darwin" };
}

function fetchJson(url, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
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

function waitForBackend() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function poll() {
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode === 200) {
          resolve();
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
    function tryNext() {
      if (Date.now() - start >= HEALTH_TIMEOUT_MS) {
        reject(new Error("Backend failed to start within 30s"));
        return;
      }
      setTimeout(poll, HEALTH_POLL_MS);
    }
    poll();
  });
}

function startBackend() {
  const { backendDir, backendEntry, frontendDist } = getPaths();
  const env = {
    ...process.env,
    OPENSPRINT_DESKTOP: "1",
    OPENSPRINT_FRONTEND_DIST: frontendDist,
  };
  const child = spawn("node", [backendEntry], {
    cwd: backendDir,
    env,
    stdio: app.isPackaged ? "ignore" : ["inherit", "pipe", "pipe"],
  });
  if (!app.isPackaged && child.stdout) {
    child.stdout.on("data", (data) => process.stdout.write(data));
  }
  if (!app.isPackaged && child.stderr) {
    child.stderr.on("data", (data) => process.stderr.write(data));
  }
  child.on("error", (err) => {
    console.error("Backend process error:", err);
  });
  child.on("exit", (code, signal) => {
    if (code != null && code !== 0) {
      console.error("Backend exited with code", code);
    }
    if (signal) {
      console.error("Backend killed with signal", signal);
    }
  });
  return child;
}

function createWindow() {
  const appIconPath = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    icon: appIconPath || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${BACKEND_PORT}`);
  mainWindow.on("close", (e) => {
    if (isQuitting) {
      return;
    }
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return Promise.resolve();
  const { normalPath, withDotPath, isTemplate } = getTrayIconPaths();
  return Promise.all([
    fetchJson(`${API_BASE}/agents/active-count`).catch(() => ({ data: { count: 0 } })),
    fetchJson(`${API_BASE}/notifications/pending-count`).catch(() => ({ data: { count: 0 } })),
    fetchJson(`${API_BASE}/global-settings`).catch(() => ({ data: { showNotificationDotInMenuBar: true } })),
  ]).then(([agentsRes, notifRes, settingsRes]) => {
    if (!tray || tray.isDestroyed()) return;
    const agentCount = agentsRes.data?.count ?? 0;
    const pendingCount = notifRes.data?.count ?? 0;
    const showDot = settingsRes.data?.showNotificationDotInMenuBar !== false;
    const useDotIcon = pendingCount > 0 && showDot;
    const iconPath = useDotIcon ? withDotPath : normalPath;
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) img = nativeImage.createFromPath(normalPath);
    if (isTemplate && !img.isEmpty()) img.setTemplateImage(true);
    tray.setImage(img);
    // macOS: show agent count to the right of the menu bar icon when setting enabled (e.g. "1", "9+")
    if (process.platform === "darwin") {
      const showCount = settingsRes.data?.showRunningAgentCountInMenuBar !== false;
      const title = showCount
        ? (agentCount === 0 ? "" : agentCount > 9 ? "9+" : String(agentCount))
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

function createTray() {
  const { normalPath, isTemplate } = getTrayIconPaths();
  let img = nativeImage.createFromPath(normalPath);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(path.dirname(normalPath), "favicon-16x16.png"));
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

function killBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    backendProcess = null;
  }
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) {
    return;
  }

  applyRuntimeBranding();
  backendProcess = startBackend();
  try {
    await waitForBackend();
  } catch (err) {
    console.error(err.message);
    killBackend();
    app.exit(1);
    return;
  }
  createWindow();
  createTray();
  setInterval(refreshTrayMenu, TRAY_REFRESH_MS);
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  killBackend();
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  killBackend();
});
