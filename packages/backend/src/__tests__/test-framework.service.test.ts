import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { detectTestFramework } from "../services/test-framework.service.js";

describe("test-framework.service", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = path.join(os.tmpdir(), `opensprint-tf-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  });

  describe("detectTestFramework", () => {
    it("detects Playwright from package.json dependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          dependencies: { "@playwright/test": "^1.40.0" },
          devDependencies: {},
        })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "playwright",
        testCommand: "npx playwright test",
      });
    });

    it("detects Vitest from devDependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          dependencies: {},
          devDependencies: { vitest: "^1.0.0" },
        })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "vitest",
        testCommand: "npx vitest run",
      });
    });

    it("detects Jest from devDependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          devDependencies: { jest: "^29.0.0" },
        })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "jest",
        testCommand: "npm test",
      });
    });

    it("detects Cypress from dependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({ dependencies: { cypress: "^13.0.0" } })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "cypress",
        testCommand: "npx cypress run",
      });
    });

    it("detects Mocha from dependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({ dependencies: { mocha: "^10.0.0" } })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "mocha",
        testCommand: "npm test",
      });
    });

    it("detects Vitest from a vitest-based test script", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest run" },
        })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "vitest",
        testCommand: "npx vitest run",
      });
    });

    it("returns null when scripts.test is default placeholder", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        })
      );

      const result = await detectTestFramework(repoPath);
      expect(result).toBeNull();
    });

    it("detects vitest from config file when package.json has no test deps", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({}));
      await fs.writeFile(path.join(repoPath, "vitest.config.ts"), "export default {}");

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "vitest",
        testCommand: "npx vitest run",
      });
    });

    it("prefers Vitest workspace config over a generic workspace test script", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*"],
          scripts: { test: "npm run test --workspaces --if-present" },
        })
      );
      await fs.writeFile(path.join(repoPath, "vitest.workspace.ts"), "export default []");

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "vitest",
        testCommand: "npx vitest run",
      });
    });

    it("detects jest from jest.config.js", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({}));
      await fs.writeFile(path.join(repoPath, "jest.config.js"), "module.exports = {}");

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "jest",
        testCommand: "npx jest",
      });
    });

    it("detects pytest from pytest.ini", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({}));
      await fs.writeFile(path.join(repoPath, "pytest.ini"), "[pytest]");

      const result = await detectTestFramework(repoPath);
      expect(result).toEqual({
        framework: "pytest",
        testCommand: "pytest",
      });
    });

    it("returns null when no package.json and no config files", async () => {
      const result = await detectTestFramework(repoPath);
      expect(result).toBeNull();
    });

    it("returns null when package.json is malformed", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), "{ invalid json");

      const result = await detectTestFramework(repoPath);
      expect(result).toBeNull();
    });

    it("returns null for nonexistent repo path", async () => {
      const result = await detectTestFramework(path.join(repoPath, "nonexistent-subdir"));
      expect(result).toBeNull();
    });
  });
});
