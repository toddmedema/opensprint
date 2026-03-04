/**
 * Verification test: dev servers use source-direct imports.
 * - Root dev script builds shared first, then watches via concurrently.
 * - Frontend Vite config aliases @opensprint/shared to source for HMR.
 * - Both frontend and backend vitest configs alias to source for npm test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const sharedRoot = resolve(__dirname, "../..");

describe("dev config (source-direct imports)", () => {
  it("root dev script builds shared and starts concurrently", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    const devScript = pkg.scripts?.dev ?? "";
    expect(devScript).toContain("build -w packages/shared");
    expect(devScript).toContain("concurrently");
  });

  it("frontend vite.config aliases @opensprint/shared to source", () => {
    const viteConfigPath = resolve(repoRoot, "packages/frontend/vite.config.ts");
    expect(existsSync(viteConfigPath)).toBe(true);
    const content = readFileSync(viteConfigPath, "utf-8");
    expect(content).toContain("@opensprint/shared");
    expect(content).toMatch(/shared\/src\/index\.ts/);
  });

  it("backend vitest.config aliases @opensprint/shared to source", () => {
    const vitestPath = resolve(repoRoot, "packages/backend/vitest.config.ts");
    expect(existsSync(vitestPath)).toBe(true);
    const content = readFileSync(vitestPath, "utf-8");
    expect(content).toContain("@opensprint/shared");
    expect(content).toMatch(/shared\/src\/index\.ts/);
  });

  it("frontend vitest.config aliases @opensprint/shared to source", () => {
    const vitestPath = resolve(repoRoot, "packages/frontend/vitest.config.ts");
    expect(existsSync(vitestPath)).toBe(true);
    const content = readFileSync(vitestPath, "utf-8");
    expect(content).toContain("@opensprint/shared");
    expect(content).toMatch(/shared\/src\/index\.ts/);
  });

  it("shared package exports have src fallback when dist absent", () => {
    const pkg = JSON.parse(readFileSync(resolve(sharedRoot, "package.json"), "utf-8"));
    const exports = pkg.exports?.["."];
    expect(exports).toBeDefined();
    const importPaths = exports.import ?? exports.default;
    const paths = Array.isArray(importPaths) ? importPaths : [importPaths];
    expect(paths.some((p: string) => p.includes("src/index.ts"))).toBe(true);
  });

  it("dev script runs shared in watch mode alongside backend and frontend", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    const devScript = pkg.scripts?.dev ?? "";
    expect(devScript).toContain("dev -w packages/shared");
    expect(devScript).toContain("dev:backend");
    expect(devScript).toContain("dev:frontend");
  });

  it("dev script starts both backend and frontend via concurrently", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    const devScript = pkg.scripts?.dev ?? "";
    expect(devScript).toContain("dev:backend");
    expect(devScript).toContain("dev:frontend");
  });

  it("setup script builds shared before applying database schema", () => {
    const setupScriptPath = resolve(repoRoot, "scripts/setup.sh");
    expect(existsSync(setupScriptPath)).toBe(true);
    const content = readFileSync(setupScriptPath, "utf-8");
    const buildIndex = content.indexOf("npm run build -w packages/shared");
    const schemaIndex = content.indexOf("npx tsx scripts/ensure-db-schema.ts");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(schemaIndex).toBeGreaterThan(buildIndex);
  });
});
