import path from "path";

/** Resolve the native SQLite module prepared for Electron's embedded Node runtime. */
export function getDesktopSqliteModulePath(options: {
  isPackaged: boolean;
  backendDir: string;
  electronDistDir: string;
}): string {
  const runtimeBackendDir = options.isPackaged
    ? options.backendDir
    : path.resolve(options.electronDistDir, "..", "desktop-resources", "backend");
  return path.join(runtimeBackendDir, "sqlite-runtime", "node_modules", "better-sqlite3");
}
