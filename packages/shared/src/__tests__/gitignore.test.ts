/**
 * Unit test: verifies that .gitignore excludes packages/shared build artifacts.
 * These are generated for production only and should never be committed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const gitignorePath = join(repoRoot, ".gitignore");

describe("gitignore excludes shared build artifacts", () => {
  it("ignores packages/shared/dist/", () => {
    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toMatch(/packages\/shared\/dist/);
  });

  it("ignores packages/shared/tsconfig.tsbuildinfo", () => {
    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toMatch(/packages\/shared\/tsconfig\.tsbuildinfo/);
  });
});
