#!/usr/bin/env npx tsx
/**
 * Performance measurement and baseline script.
 *
 * Loads the app in headless Chrome, navigates to Execute, opens a task sidebar,
 * closes it, and reports memory/CPU metrics. Use for documenting baseline
 * before/after each optimization.
 *
 * Prerequisites:
 * - Backend running on port 3100 (npm run dev:backend)
 * - Frontend running on port 5173 (npm run dev:frontend)
 * - At least one project with at least one task (for sidebar open/close)
 *
 * Usage:
 *   npm run perf
 *   npm run perf -- --baseline    # Save metrics to perf-baseline.json
 *   npm run perf -- --compare     # Compare against saved baseline
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_BASE = "http://localhost:3100/api/v1";
const APP_URL = "http://localhost:5173";

interface PerfMetrics {
  timestamp: string;
  /** Initial load metrics */
  load: {
    domContentLoaded: number;
    loadComplete: number;
    firstContentfulPaint?: number;
    timeToInteractive?: number;
  };
  /** Memory (bytes) */
  memory: {
    jsHeapUsed: number;
    jsHeapTotal: number;
    peakAfterSidebarOpen?: number;
    afterSidebarClose?: number;
  };
  /** Sidebar open/close timing (ms) */
  sidebar: {
    openToVisible?: number;
    closeToHidden?: number;
    cpuSpikeDurationMs?: number;
  };
  /** Whether sidebar was opened (requires tasks) */
  sidebarOpened: boolean;
}

const BASELINE_PATH = path.join(ROOT, "perf-baseline.json");

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function getProjectAndTask(): Promise<{ projectId: string; taskId: string } | null> {
  const projectsRes = await fetchJson<{ data?: { id: string }[] }>(`${API_BASE}/projects`);
  const projects = projectsRes?.data ?? [];
  if (!Array.isArray(projects) || projects.length === 0) return null;

  const projectId = projects[0].id;
  const tasksRes = await fetchJson<{ data?: { id: string }[] | { items: { id: string }[] } }>(
    `${API_BASE}/projects/${projectId}/tasks?limit=50`
  );
  const raw = tasksRes?.data;
  const tasks = Array.isArray(raw) ? raw : ((raw as { items?: { id: string }[] })?.items ?? []);
  const taskIds = tasks.map((t: { id: string }) => t.id);
  if (taskIds.length === 0) return null;

  return { projectId, taskId: taskIds[0] };
}

async function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function collectPageMetrics(page: Page): Promise<{
  jsHeapUsed: number;
  jsHeapTotal: number;
}> {
  const metrics = await page.metrics();
  const jsHeapUsed = (metrics.JSHeapUsedSize ?? 0) as number;
  const jsHeapTotal = (metrics.JSHeapTotalSize ?? 0) as number;
  return { jsHeapUsed, jsHeapTotal };
}

async function getNavigationTiming(page: Page): Promise<{
  domContentLoaded: number;
  loadComplete: number;
  firstContentfulPaint?: number;
}> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paint = performance.getEntriesByType("paint");
    const fcp = paint.find((p) => p.name === "first-contentful-paint");

    return {
      domContentLoaded: nav ? nav.domContentLoadedEventEnd - nav.fetchStart : 0,
      loadComplete: nav ? nav.loadEventEnd - nav.fetchStart : 0,
      firstContentfulPaint: fcp ? fcp.startTime : undefined,
    };
  });
}

async function runPerf(browser: Browser): Promise<PerfMetrics> {
  const page = await browser.newPage();

  const client = await page.target().createCDPSession();
  await client.send("Performance.enable");
  await client.send("Performance.enable", { timeDomain: "timeTicks" });

  const metrics: PerfMetrics = {
    timestamp: new Date().toISOString(),
    load: { domContentLoaded: 0, loadComplete: 0 },
    memory: { jsHeapUsed: 0, jsHeapTotal: 0 },
    sidebar: {},
    sidebarOpened: false,
  };

  try {
    const { projectId, taskId } = await getProjectAndTask();

    const loadStart = Date.now();
    await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 30000 });
    const loadEnd = Date.now();

    const navTiming = await getNavigationTiming(page);
    metrics.load = {
      ...navTiming,
      timeToInteractive: loadEnd - loadStart,
    };

    const memAfterLoad = await collectPageMetrics(page);
    metrics.memory.jsHeapUsed = memAfterLoad.jsHeapUsed;
    metrics.memory.jsHeapTotal = memAfterLoad.jsHeapTotal;

    await page.goto(`${APP_URL}/projects/${projectId}/execute`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await waitFor(500);

    if (projectId && taskId) {
      const openStart = Date.now();
      await page.goto(`${APP_URL}/projects/${projectId}/execute?task=${taskId}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page
        .waitForSelector('[data-testid="task-detail-title"], [aria-label="Close task detail"]', {
          timeout: 5000,
        })
        .catch(() => null);

      const openEnd = Date.now();
      metrics.sidebar.openToVisible = openEnd - openStart;
      metrics.sidebarOpened = true;

      await waitFor(300);

      const memAfterOpen = await collectPageMetrics(page);
      metrics.memory.peakAfterSidebarOpen = memAfterOpen.jsHeapUsed;

      const closeStart = Date.now();
      const closeBtn = await page.$('[aria-label="Close task detail"]');
      if (closeBtn) {
        await closeBtn.click();
        await waitFor(600);
        const closeEnd = Date.now();
        metrics.sidebar.closeToHidden = closeEnd - closeStart;
      }

      const memAfterClose = await collectPageMetrics(page);
      metrics.memory.afterSidebarClose = memAfterClose.jsHeapUsed;
    }
  } finally {
    await page.close();
  }

  return metrics;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function printReport(metrics: PerfMetrics): void {
  console.log("\n--- Performance Report ---\n");
  console.log(`Timestamp: ${metrics.timestamp}`);

  console.log("\nLoad:");
  console.log(`  DOM Content Loaded: ${metrics.load.domContentLoaded.toFixed(0)} ms`);
  console.log(`  Load Complete:      ${metrics.load.loadComplete.toFixed(0)} ms`);
  if (metrics.load.firstContentfulPaint != null) {
    console.log(`  FCP:                ${metrics.load.firstContentfulPaint.toFixed(0)} ms`);
  }
  if (metrics.load.timeToInteractive != null) {
    console.log(`  TTI (approx):       ${metrics.load.timeToInteractive.toFixed(0)} ms`);
  }

  console.log("\nMemory:");
  console.log(`  JS Heap Used:       ${formatBytes(metrics.memory.jsHeapUsed)}`);
  console.log(`  JS Heap Total:      ${formatBytes(metrics.memory.jsHeapTotal)}`);
  if (metrics.memory.peakAfterSidebarOpen != null) {
    console.log(`  Peak (sidebar open): ${formatBytes(metrics.memory.peakAfterSidebarOpen)}`);
  }
  if (metrics.memory.afterSidebarClose != null) {
    console.log(`  After sidebar close: ${formatBytes(metrics.memory.afterSidebarClose)}`);
  }

  if (metrics.sidebarOpened) {
    console.log("\nSidebar:");
    if (metrics.sidebar.openToVisible != null) {
      console.log(`  Open to visible:    ${metrics.sidebar.openToVisible} ms`);
    }
    if (metrics.sidebar.closeToHidden != null) {
      console.log(`  Close to hidden:    ${metrics.sidebar.closeToHidden} ms`);
    }
  } else {
    console.log("\nSidebar: Not opened (no tasks in project).");
  }
  console.log("");
}

function compareWithBaseline(current: PerfMetrics): void {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log("No baseline found. Run with --baseline to save one.\n");
    return;
  }

  const baselineJson = fs.readFileSync(BASELINE_PATH, "utf-8");
  const baseline = JSON.parse(baselineJson) as PerfMetrics;

  console.log("\n--- Comparison vs Baseline ---\n");

  const loadDelta = current.load.loadComplete - baseline.load.loadComplete;
  if (baseline.load.loadComplete > 0) {
    const pct = Math.round((loadDelta / baseline.load.loadComplete) * 100);
    console.log(`Load complete: ${loadDelta >= 0 ? "+" : ""}${loadDelta} ms (${pct}%)`);
  }

  const memDelta = current.memory.jsHeapUsed - baseline.memory.jsHeapUsed;
  if (baseline.memory.jsHeapUsed > 0) {
    const pct = Math.round((memDelta / baseline.memory.jsHeapUsed) * 100);
    console.log(`JS Heap Used: ${memDelta >= 0 ? "+" : ""}${formatBytes(memDelta)} (${pct}%)`);
  }

  if (current.sidebarOpened && baseline.sidebarOpened) {
    const closeDelta = (current.sidebar.closeToHidden ?? 0) - (baseline.sidebar.closeToHidden ?? 0);
    console.log(`Sidebar close: ${closeDelta >= 0 ? "+" : ""}${closeDelta} ms`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes("--baseline");
  const compare = args.includes("--compare");

  console.log("Checking servers...");
  try {
    await fetch(`${API_BASE}/projects`).then((r) => r.ok);
  } catch {
    console.error("Backend not reachable at", API_BASE);
    console.error("Start with: npm run dev:backend");
    process.exit(1);
  }

  try {
    await fetch(APP_URL).then((r) => r.ok);
  } catch {
    console.error("Frontend not reachable at", APP_URL);
    console.error("Start with: npm run dev:frontend");
    process.exit(1);
  }

  console.log("Launching headless Chrome...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const metrics = await runPerf(browser);
    printReport(metrics);

    if (saveBaseline) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(metrics, null, 2));
      console.log(`Baseline saved to ${BASELINE_PATH}\n`);
    }

    if (compare) {
      compareWithBaseline(metrics);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
