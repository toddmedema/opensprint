#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const backendDir = path.join(repoRoot, "packages", "backend");
const frontendDir = path.join(repoRoot, "packages", "frontend");
const electronPackageDir = path.join(repoRoot, "packages", "electron");
const iconComposerDir = path.join(electronPackageDir, "build", "OpenSprint.icon");
const iconComposerAssetsDir = path.join(iconComposerDir, "Assets");
const runtimeDepsTemplateDir = path.join(repoRoot, "packages", "electron", "runtime-deps");
const outDir = path.join(repoRoot, "packages", "electron", "desktop-resources");
// Keep only native modules external; bundle pure JS deps so runtime install is minimal.
const backendExternalDeps = ["better-sqlite3"];
const SQLITE_MODULE_NAME = "better-sqlite3";
const SQLITE_RUNTIME_FALLBACK_DIR_NAME = "sqlite-runtime";
const SQLITE_RUNTIME_FALLBACK_PACKAGES = [SQLITE_MODULE_NAME, "bindings", "file-uri-to-path"];
const SQLITE_BINDING_RELATIVE_PATH = path.join(
  "node_modules",
  SQLITE_MODULE_NAME,
  "build",
  "Release",
  "better_sqlite3.node"
);
const removableDirNames = new Set([
  "test",
  "tests",
  "__tests__",
  "doc",
  "docs",
  "example",
  "examples",
  "benchmark",
  "bench",
]);

function parseCliOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const [flag, inlineValue] = raw.split("=", 2);
    const nextValue = inlineValue ?? argv[i + 1];
    if (
      (flag === "--arch" || flag === "--electron-version" || flag === "--platform") &&
      nextValue
    ) {
      if (inlineValue == null) {
        i += 1;
      }
      if (flag === "--arch") options.arch = String(nextValue).trim();
      if (flag === "--electron-version") options.electronVersion = String(nextValue).trim();
      if (flag === "--platform") options.platform = String(nextValue).trim();
    }
  }
  return options;
}

function resolveElectronVersion(cliOptions = {}) {
  const fromCli = cliOptions.electronVersion?.trim();
  if (fromCli) return fromCli;

  const fromEnv = process.env.OPENSPRINT_ELECTRON_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const installed = resolveInstalledElectronVersion();
  const configured = resolveConfiguredElectronVersion();
  if (installed) {
    if (configured && configured !== installed) {
      console.warn(
        `Configured Electron version (${configured}) does not match installed Electron version (${installed}); using installed version for native rebuilds.`
      );
    }
    return installed;
  }
  if (configured) {
    return configured;
  }

  const electronPkgPath = path.join(repoRoot, "packages", "electron", "package.json");
  throw new Error(
    `Could not resolve Electron version. Install Electron locally, set OPENSPRINT_ELECTRON_VERSION, or define electronVersion in ${electronPkgPath}.`
  );
}

function resolveInstalledElectronVersion() {
  try {
    const electronEntryPath = require.resolve("electron", {
      paths: [electronPackageDir, repoRoot],
    });
    const electronPkgPath = path.join(path.dirname(electronEntryPath), "package.json");
    const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, "utf8"));
    return normalizeElectronVersion(electronPkg?.version);
  } catch {
    return "";
  }
}

function resolveConfiguredElectronVersion() {
  const electronPkgPath = path.join(repoRoot, "packages", "electron", "package.json");
  const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, "utf8"));
  const raw =
    electronPkg?.build?.electronVersion ??
    electronPkg?.devDependencies?.electron ??
    electronPkg?.dependencies?.electron;
  return normalizeElectronVersion(raw);
}

function normalizeElectronVersion(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^[^\d]*/, "");
}

function resolveTargetArch(cliOptions = {}) {
  const fromCli = cliOptions.arch?.trim();
  if (fromCli) return fromCli;

  const fromEnv = process.env.OPENSPRINT_ELECTRON_ARCH?.trim();
  if (fromEnv) return fromEnv;
  return process.arch;
}

function resolveTargetPlatform(cliOptions = {}) {
  const fromCli = cliOptions.platform?.trim();
  const fromEnv = process.env.OPENSPRINT_ELECTRON_PLATFORM?.trim();
  const targetPlatform = fromCli || fromEnv || process.platform;
  if (!["win32", "darwin", "linux"].includes(targetPlatform)) {
    throw new Error(
      `Unsupported target platform '${targetPlatform}'. Use one of: win32, darwin, linux.`
    );
  }
  return targetPlatform;
}

function hasPythonDistutils(pythonPath) {
  if (!pythonPath) return false;
  try {
    execFileSync(
      pythonPath,
      ["-c", "import distutils.version; import sys; sys.stdout.write('ok')"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return true;
  } catch {
    return false;
  }
}

function resolveNativeBuildPython() {
  const envCandidates = [
    process.env.OPENSPRINT_NATIVE_BUILD_PYTHON,
    process.env.PYTHON,
    process.env.npm_config_python,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const pathCandidates =
    process.platform === "darwin"
      ? ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"]
      : ["python3"];

  for (const candidate of [...envCandidates, ...pathCandidates]) {
    if (hasPythonDistutils(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createNativeBuildEnv() {
  const env = { ...process.env };
  delete env.npm_config_python;
  delete env.NPM_CONFIG_PYTHON;
  const pythonPath = resolveNativeBuildPython();
  if (pythonPath) {
    env.PYTHON = pythonPath;
  }
  return env;
}

function findPackageRoot(startDir, packageName) {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (packageJson?.name === packageName) {
          return currentDir;
        }
      } catch {
        // Keep walking up until we find a valid package.json for the requested package.
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  throw new Error(`Could not locate package root for '${packageName}' from '${startDir}'.`);
}

function resolveElectronRebuildCliPath() {
  const rebuildEntryPath = require.resolve("@electron/rebuild", {
    paths: [electronPackageDir, repoRoot],
  });
  const rebuildPackageRoot = findPackageRoot(path.dirname(rebuildEntryPath), "@electron/rebuild");
  const rebuildPackageJsonPath = path.join(rebuildPackageRoot, "package.json");
  const rebuildPackageJson = JSON.parse(fs.readFileSync(rebuildPackageJsonPath, "utf8"));
  const binField = rebuildPackageJson?.bin;
  const cliRelativePath =
    typeof binField === "string"
      ? binField
      : typeof binField?.["electron-rebuild"] === "string"
        ? binField["electron-rebuild"]
        : "";
  if (!cliRelativePath) {
    throw new Error(
      `Could not resolve electron-rebuild CLI from ${rebuildPackageJsonPath}. Missing bin entry.`
    );
  }
  const cliPath = path.join(rebuildPackageRoot, cliRelativePath);
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Resolved electron-rebuild CLI does not exist: ${cliPath}`);
  }
  return cliPath;
}

function buildElectronRebuildArgs({
  electronVersion,
  moduleDir,
  targetArch,
  force = false,
  buildFromSource = false,
}) {
  const args = [
    "electron-rebuild",
    "--version",
    electronVersion,
    "--module-dir",
    moduleDir,
    "--arch",
    targetArch,
  ];
  if (force) {
    args.push("--force");
  }
  if (buildFromSource) {
    args.push("--build-from-source");
  }
  return args;
}

function runElectronRebuild(options, nativeBuildEnv) {
  const electronRebuildCliPath = resolveElectronRebuildCliPath();
  execFileSync(
    process.execPath,
    [electronRebuildCliPath, ...buildElectronRebuildArgs(options).slice(1)],
    {
      cwd: electronPackageDir,
      env: nativeBuildEnv,
      stdio: "inherit",
    }
  );
}

async function run() {
  console.log("Preparing desktop resources...");
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const electronVersion = resolveElectronVersion(cliOptions);
  const targetArch = resolveTargetArch(cliOptions);
  const targetPlatform = resolveTargetPlatform(cliOptions);
  const nativeBuildEnv = createNativeBuildEnv();
  const selectedPython = nativeBuildEnv.PYTHON?.trim();
  if (selectedPython) {
    console.log(`Using Python for native module rebuilds: ${selectedPython}`);
  }
  await generateIconComposerAssets();

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const backendOut = path.join(outDir, "backend");
  const frontendOut = path.join(outDir, "frontend");

  fs.mkdirSync(backendOut, { recursive: true });
  await bundleBackendRuntime(backendOut);
  copyRuntimeDependencyTemplate(backendOut);

  console.log(
    `Installing backend runtime dependencies (runtime=electron, version=${electronVersion}, platform=${targetPlatform}, arch=${targetArch})...`
  );
  execSync("npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund", {
    cwd: backendOut,
    env: nativeBuildEnv,
    stdio: "inherit",
  });
  console.log("Rebuilding native modules for Electron...");
  runElectronRebuild(
    {
      electronVersion,
      moduleDir: backendOut,
      targetArch,
    },
    nativeBuildEnv
  );
  const sqliteRuntimeDiagnostics = ensureSqliteRuntimeLoadable(
    backendOut,
    electronVersion,
    targetPlatform,
    targetArch,
    nativeBuildEnv
  );

  console.log("Pruning non-runtime files from backend node_modules...");
  pruneBackendNodeModules(path.join(backendOut, "node_modules"));
  console.log("Staging SQLite runtime fallback modules...");
  const sqliteFallbackDiagnostics = stageSqliteRuntimeFallback(backendOut);
  writeRuntimeDiagnosticsManifest(backendOut, {
    ...sqliteRuntimeDiagnostics,
    fallback: sqliteFallbackDiagnostics,
  });

  fs.cpSync(path.join(frontendDir, "dist"), frontendOut, { recursive: true });

  // Generate macOS tray template icons (black logo on transparent) so the menu bar shows the three triangles
  await generateTrayIcons(frontendOut);

  console.log("Desktop resources ready at", outDir);
}

async function generateIconComposerAssets() {
  const iconJsonPath = path.join(iconComposerDir, "icon.json");
  const logoIconSvg = path.join(frontendDir, "public", "logo-icon.svg");
  if (!fs.existsSync(iconJsonPath)) {
    return;
  }
  if (!fs.existsSync(logoIconSvg)) {
    console.warn(
      `Skipping Icon Composer asset generation: source logo SVG is missing at ${logoIconSvg}`
    );
    return;
  }

  let sharp;
  try {
    sharp = require("sharp");
  } catch (err) {
    console.warn(
      `Skipping Icon Composer asset generation: sharp is unavailable (${
        err instanceof Error ? err.message : String(err)
      })`
    );
    return;
  }

  const baseSvg = fs.readFileSync(logoIconSvg, "utf8");
  const lightSvg = baseSvg;
  const darkSvg = baseSvg
    .replace(/#c7d2fe/gi, "#dbeafe")
    .replace(/#818cf8/gi, "#a5b4fc")
    .replace(/#4f46e5/gi, "#6366f1");
  const tintedSvg = baseSvg.replace(/fill="#[^"]+"/gi, 'fill="#ffffff"');
  const variants = [
    { fileName: "light.png", svg: lightSvg },
    { fileName: "dark.png", svg: darkSvg },
    { fileName: "tinted.png", svg: tintedSvg },
  ];

  fs.mkdirSync(iconComposerAssetsDir, { recursive: true });

  for (const variant of variants) {
    const png = await renderIconComposerVariant(variant.svg, sharp);
    fs.writeFileSync(path.join(iconComposerAssetsDir, variant.fileName), png);
  }

  console.log(`Generated Icon Composer image variants in ${iconComposerAssetsDir}`);
}

async function renderIconComposerVariant(svg, sharp) {
  const canvasSize = 1024;
  const renderSize = Math.round(canvasSize * 0.9);
  const opticalShiftX = 46;
  const top = Math.round((canvasSize - renderSize) / 2);
  const left = Math.round((canvasSize - renderSize) / 2 + opticalShiftX);
  const layer = await sharp(Buffer.from(svg))
    .resize(renderSize, renderSize, { fit: "contain" })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: layer, left, top }])
    .png()
    .toBuffer();
}

function ensureSqliteRuntimeLoadable(
  backendOut,
  electronVersion,
  targetPlatform,
  targetArch,
  nativeBuildEnv
) {
  console.log(
    `Verifying ${SQLITE_MODULE_NAME} runtime load (electron=${electronVersion}, platform=${targetPlatform}, arch=${targetArch})...`
  );
  const initialDiagnostics = collectSqliteRuntimeDiagnostics(
    backendOut,
    electronVersion,
    targetPlatform,
    targetArch
  );
  if (targetPlatform !== process.platform) {
    const reason = `Skipping runtime probe for cross-platform build (host=${process.platform}, target=${targetPlatform}).`;
    console.warn(reason);
    return {
      ...initialDiagnostics,
      recoveredViaSourceRebuild: false,
      probe: {
        ok: null,
        skipped: true,
        reason,
      },
    };
  }
  if (targetArch !== process.arch) {
    const reason = `Skipping runtime probe for cross-arch build (host=${process.arch}, target=${targetArch}).`;
    console.warn(reason);
    return {
      ...initialDiagnostics,
      recoveredViaSourceRebuild: false,
      probe: {
        ok: null,
        skipped: true,
        reason,
      },
    };
  }
  let probe = runSqliteProbeWithElectron(backendOut);
  if (probe.skipped) {
    console.warn(probe.reason);
    return {
      ...initialDiagnostics,
      recoveredViaSourceRebuild: false,
      probe,
    };
  }
  if (probe.ok) {
    console.log(`${SQLITE_MODULE_NAME} verification passed.`);
    return {
      ...initialDiagnostics,
      recoveredViaSourceRebuild: false,
      probe,
    };
  }

  logProbeFailure("Initial SQLite runtime verification failed", probe, initialDiagnostics);
  console.warn(`Attempting source rebuild for ${SQLITE_MODULE_NAME}...`);
  runElectronRebuild(
    {
      electronVersion,
      moduleDir: backendOut,
      targetArch,
      force: true,
      buildFromSource: true,
    },
    nativeBuildEnv
  );

  const rebuiltDiagnostics = collectSqliteRuntimeDiagnostics(
    backendOut,
    electronVersion,
    targetPlatform,
    targetArch
  );
  probe = runSqliteProbeWithElectron(backendOut);
  if (probe.ok) {
    console.log(`${SQLITE_MODULE_NAME} verification passed after source rebuild.`);
    return {
      ...rebuiltDiagnostics,
      recoveredViaSourceRebuild: true,
      probe,
    };
  }

  logProbeFailure(
    "SQLite runtime verification still failing after source rebuild",
    probe,
    rebuiltDiagnostics
  );
  const details = JSON.stringify(
    {
      diagnostics: rebuiltDiagnostics,
      probe,
    },
    null,
    2
  );
  throw new Error(
    `Could not produce a loadable ${SQLITE_MODULE_NAME} runtime for electron=${electronVersion}, platform=${targetPlatform}, arch=${targetArch}. Details:\n${details}`
  );
}

function collectSqliteRuntimeDiagnostics(backendOut, electronVersion, targetPlatform, targetArch) {
  const modulePath = path.join(backendOut, "node_modules", SQLITE_MODULE_NAME);
  const bindingPath = path.join(backendOut, SQLITE_BINDING_RELATIVE_PATH);
  const bindingExists = fs.existsSync(bindingPath);
  const bindingStats = bindingExists ? fs.statSync(bindingPath) : null;
  return {
    generatedAt: new Date().toISOString(),
    hostPlatform: process.platform,
    hostArch: process.arch,
    targetPlatform,
    targetArch,
    electronVersion,
    backendOut,
    modulePath,
    moduleExists: fs.existsSync(modulePath),
    bindingPath,
    bindingExists,
    bindingBytes: bindingStats ? bindingStats.size : null,
    bindingModifiedAt: bindingStats ? bindingStats.mtime.toISOString() : null,
  };
}

function runSqliteProbeWithElectron(backendOut) {
  const electronBinaryResolution = resolveElectronBinaryPath();
  if (!electronBinaryResolution.path) {
    return {
      ok: null,
      skipped: true,
      reason: electronBinaryResolution.error,
      stdout: "",
      stderr: "",
      code: "skipped",
    };
  }
  const electronBinary = electronBinaryResolution.path;
  const script = `
const path = require("path");
const backendOut = process.argv[1];
const modulePath = path.join(backendOut, "node_modules", "better-sqlite3");
const Database = require(modulePath);
const db = new Database(":memory:");
const row = db.prepare("SELECT 1 AS ok").get();
db.close();
if (!row || row.ok !== 1) {
  throw new Error("Unexpected SQLite probe result");
}
console.log("sqlite-probe-ok");
`;

  try {
    const stdout = execFileSync(electronBinary, ["-e", script, backendOut], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: true,
      stdout: String(stdout ?? "").trim(),
      stderr: "",
      code: 0,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout ?? "").trim(),
      stderr: String(err.stderr ?? "").trim(),
      errorMessage: err instanceof Error ? err.message : String(err),
      code:
        typeof err.status === "number"
          ? err.status
          : typeof err.code === "number"
            ? err.code
            : typeof err.code === "string"
              ? err.code
              : "unknown",
    };
  }
}

function resolveElectronBinaryPath() {
  const fromEnv = process.env.OPENSPRINT_ELECTRON_BINARY_PATH?.trim();
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) {
      return { path: fromEnv, error: null };
    }
    return {
      path: null,
      error: `Skipping SQLite runtime verification: OPENSPRINT_ELECTRON_BINARY_PATH is set but file does not exist (${fromEnv}).`,
    };
  }

  try {
    const binaryPath = require("electron");
    if (typeof binaryPath === "string" && binaryPath.trim()) {
      return { path: binaryPath, error: null };
    }
  } catch (err) {
    return {
      path: null,
      error: `Skipping SQLite runtime verification because Electron binary path could not be resolved: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    path: null,
    error: "Skipping SQLite runtime verification because Electron binary path is empty.",
  };
}

function logProbeFailure(message, probe, diagnostics) {
  console.warn(message);
  console.warn(
    JSON.stringify(
      {
        diagnostics,
        probe,
      },
      null,
      2
    )
  );
}

function writeRuntimeDiagnosticsManifest(backendOut, diagnostics) {
  const manifestPath = path.join(backendOut, "runtime-diagnostics.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  console.log(`Wrote desktop runtime diagnostics manifest: ${manifestPath}`);
}

async function bundleBackendRuntime(
  backendOut,
  entryPoint = path.join(backendDir, "dist", "index.js")
) {
  const esbuild = require("esbuild");
  const outFile = path.join(backendOut, "dist", "services", "index.mjs");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Preserve docs path resolution in help-chat service by keeping bundle under dist/services.
  fs.cpSync(path.join(backendDir, "docs"), path.join(backendOut, "docs"), { recursive: true });
  // Schema discovery resolves migrations relative to the bundled module's import.meta.url.
  fs.cpSync(
    path.join(backendDir, "src", "db", "migrations"),
    path.join(path.dirname(outFile), "migrations"),
    { recursive: true }
  );

  console.log("Bundling backend runtime...");
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    // Bundled CommonJS dependencies still require Node built-ins at runtime.
    banner: {
      js: 'import { createRequire as __opensprintCreateRequire } from "node:module"; const require = __opensprintCreateRequire(import.meta.url);',
    },
    target: ["node24"],
    minify: true,
    sourcemap: false,
    legalComments: "none",
    external: backendExternalDeps,
    logLevel: "info",
  });
}

function copyRuntimeDependencyTemplate(backendOut) {
  const templatePackagePath = path.join(runtimeDepsTemplateDir, "package.json");
  const templateLockPath = path.join(runtimeDepsTemplateDir, "package-lock.json");
  if (!fs.existsSync(templatePackagePath) || !fs.existsSync(templateLockPath)) {
    throw new Error(
      "Missing runtime dependency template. Expected package.json and package-lock.json in packages/electron/runtime-deps."
    );
  }

  const backendPkgPath = path.join(backendDir, "package.json");
  const backendPkg = JSON.parse(fs.readFileSync(backendPkgPath, "utf8"));
  const templatePkg = JSON.parse(fs.readFileSync(templatePackagePath, "utf8"));

  for (const dep of backendExternalDeps) {
    if (!backendPkg.dependencies?.[dep]) {
      throw new Error(`Missing dependency '${dep}' in ${backendPkgPath}`);
    }
    const pinned = templatePkg.dependencies?.[dep];
    if (typeof pinned !== "string" || /[~^*><= ]/.test(pinned)) {
      throw new Error(
        `packages/electron/runtime-deps/package.json must pin '${dep}' to an exact version (no ranges).`
      );
    }
  }

  fs.copyFileSync(templatePackagePath, path.join(backendOut, "package.json"));
  fs.copyFileSync(templateLockPath, path.join(backendOut, "package-lock.json"));
}

function pruneBackendNodeModules(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) return;

  walk(nodeModulesDir);
  // Source assets used only for rebuilding native module, not required at runtime.
  removeIfExists(path.join(nodeModulesDir, "better-sqlite3", "deps"));

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (removableDirNames.has(entry.name.toLowerCase())) {
          removeIfExists(fullPath);
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && shouldPruneFile(entry.name)) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  }
}

function stageSqliteRuntimeFallback(backendOut) {
  const nodeModulesDir = path.join(backendOut, "node_modules");
  const fallbackRuntimeDir = path.join(backendOut, SQLITE_RUNTIME_FALLBACK_DIR_NAME);
  const fallbackNodeModulesDir = path.join(fallbackRuntimeDir, "node_modules");
  removeIfExists(fallbackRuntimeDir);
  fs.mkdirSync(fallbackNodeModulesDir, { recursive: true });

  for (const packageName of SQLITE_RUNTIME_FALLBACK_PACKAGES) {
    const sourcePath = path.join(nodeModulesDir, packageName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `SQLite runtime fallback package '${packageName}' is missing at ${sourcePath}.`
      );
    }
    fs.cpSync(sourcePath, path.join(fallbackNodeModulesDir, packageName), { recursive: true });
  }

  pruneBackendNodeModules(fallbackNodeModulesDir);

  const fallbackBindingPath = path.join(
    fallbackNodeModulesDir,
    SQLITE_MODULE_NAME,
    "build",
    "Release",
    "better_sqlite3.node"
  );
  const fallbackBindingExists = fs.existsSync(fallbackBindingPath);
  if (!fallbackBindingExists) {
    throw new Error(`SQLite runtime fallback is missing native binding: ${fallbackBindingPath}`);
  }

  return {
    runtimeDir: fallbackRuntimeDir,
    nodeModulesDir: fallbackNodeModulesDir,
    modulePath: path.join(fallbackNodeModulesDir, SQLITE_MODULE_NAME),
    packageCount: SQLITE_RUNTIME_FALLBACK_PACKAGES.length,
    packages: SQLITE_RUNTIME_FALLBACK_PACKAGES,
    bindingPath: fallbackBindingPath,
    bindingExists: fallbackBindingExists,
  };
}

function shouldPruneFile(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".map") ||
    lower.endsWith(".d.ts") ||
    lower.endsWith(".d.cts") ||
    lower.endsWith(".d.mts")
  );
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function generateTrayIcons(frontendOut) {
  return (async function () {
    const logoIconSvg = path.join(frontendDir, "public", "logo-icon.svg");
    if (!fs.existsSync(logoIconSvg)) return;
    try {
      const sharp = require("sharp");
      let svg = fs.readFileSync(logoIconSvg, "utf8");
      // Template images must be black on transparent for macOS menu bar
      svg = svg.replace(/fill="#[^"]+"/g, 'fill="#000000"');
      const size = 16;
      const size2x = 32;
      const buf = Buffer.from(svg);
      // 1x (16x16)
      await sharp(buf)
        .resize(size, size)
        .png()
        .toFile(path.join(frontendOut, "trayIconTemplate.png"));
      // 2x retina (32x32) — macOS picks up @2x automatically for HiDPI menu bar
      await sharp(buf)
        .resize(size2x, size2x)
        .png()
        .toFile(path.join(frontendOut, "trayIconTemplate@2x.png"));
      // Dot variant: same icon with a small badge circle (for notification state)
      const dotSize = 4;
      const dotX = size - dotSize - 1;
      const dotY = 1;
      const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${dotX + dotSize / 2}" cy="${dotY + dotSize / 2}" r="${dotSize / 2}" fill="#000000"/></svg>`;
      const basePng = await sharp(buf).resize(size, size).png().toBuffer();
      const dotOverlay = await sharp(Buffer.from(dotSvg)).resize(size, size).png().toBuffer();
      await sharp(basePng)
        .composite([{ input: dotOverlay, left: 0, top: 0 }])
        .png()
        .toFile(path.join(frontendOut, "trayIconTemplateDot.png"));
      // 2x retina dot variant
      const dotSize2x = 8;
      const dotX2x = size2x - dotSize2x - 2;
      const dotY2x = 2;
      const dotSvg2x = `<svg xmlns="http://www.w3.org/2000/svg" width="${size2x}" height="${size2x}"><circle cx="${dotX2x + dotSize2x / 2}" cy="${dotY2x + dotSize2x / 2}" r="${dotSize2x / 2}" fill="#000000"/></svg>`;
      const basePng2x = await sharp(buf).resize(size2x, size2x).png().toBuffer();
      const dotOverlay2x = await sharp(Buffer.from(dotSvg2x))
        .resize(size2x, size2x)
        .png()
        .toBuffer();
      await sharp(basePng2x)
        .composite([{ input: dotOverlay2x, left: 0, top: 0 }])
        .png()
        .toFile(path.join(frontendOut, "trayIconTemplateDot@2x.png"));
    } catch (err) {
      console.warn("Could not generate tray icons:", err.message);
    }
  })();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  bundleBackendRuntime,
  buildElectronRebuildArgs,
  generateIconComposerAssets,
  parseCliOptions,
  resolveElectronVersion,
  resolveInstalledElectronVersion,
  resolveConfiguredElectronVersion,
  normalizeElectronVersion,
  resolveTargetArch,
  resolveTargetPlatform,
  runSqliteProbeWithElectron,
};
