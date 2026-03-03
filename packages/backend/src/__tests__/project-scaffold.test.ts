import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectService } from "../services/project.service.js";
import type { DbClient } from "../db/client.js";

const { testClientRef } = vi.hoisted(() => ({
  testClientRef: { current: null as DbClient | null },
}));

vi.mock("../services/scaffold-recovery.service.js", () => ({
  classifyInitError: () => ({
    category: "unknown",
    recoverable: false,
    summary: "Unknown",
    rawError: "",
  }),
  attemptRecovery: async () => ({ success: false, category: "unknown" as const }),
}));

vi.mock("../services/task-store.service.js", async () => {
  const { SCHEMA_SQL, runSchema } = await import("../db/schema.js");
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  testClientRef.current = dbResult?.client ?? null;
  if (dbResult) await runSchema(dbResult.client);
  return {
    taskStore: {
      init: vi.fn().mockImplementation(async () => {}),
      getDb: vi.fn().mockImplementation(async () => testClientRef.current),
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (c: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
      listAll: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      show: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: "os-0001" }),
      createMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteByProjectId: vi.fn().mockResolvedValue(undefined),
      deleteOpenQuestionsByProjectId: vi.fn().mockResolvedValue(undefined),
      addDependency: vi.fn().mockResolvedValue(undefined),
      ready: vi.fn().mockResolvedValue([]),
      setOnTaskChange: vi.fn(),
      planInsert: vi.fn(),
      planGet: vi.fn().mockResolvedValue(null),
      planListIds: vi.fn().mockResolvedValue([]),
      planDelete: vi.fn().mockResolvedValue(false),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL,
    _postgresAvailable: !!dbResult,
  };
});

let expoInstallShouldFail = false;
let gitCheckShouldFail = false;
let nodeCheckShouldFail = false;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    exec: (
      cmd: string,
      optsOrCb: unknown,
      cb?: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const opts = typeof optsOrCb === "function" ? {} : (optsOrCb as { cwd?: string });
      const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
        err: Error | null,
        stdout?: string,
        stderr?: string
      ) => void;
      if (cmd.trim() === "git --version") {
        if (gitCheckShouldFail) {
          const err = new Error("git: command not found") as Error & { code?: string };
          err.code = "ENOENT";
          callback(err, "", "git: command not found");
        } else {
          const execOpts = typeof optsOrCb === "function" ? {} : (optsOrCb as object);
          (
            actual.exec as (
              a: string,
              b: unknown,
              c: (err: Error | null, stdout?: string, stderr?: string) => void
            ) => void
          )(cmd, execOpts, callback);
        }
        return;
      }
      if (cmd.trim() === "node --version") {
        if (nodeCheckShouldFail) {
          const err = new Error("node: command not found") as Error & { code?: string };
          err.code = "ENOENT";
          callback(err, "", "node: command not found");
        } else {
          const execOpts = typeof optsOrCb === "function" ? {} : (optsOrCb as object);
          (
            actual.exec as (
              a: string,
              b: unknown,
              c: (err: Error | null, stdout?: string, stderr?: string) => void
            ) => void
          )(cmd, execOpts, callback);
        }
        return;
      }
      if (cmd.includes("create-expo-app")) {
        const cwd = opts.cwd || process.cwd();
        const pkgPath = path.join(cwd, "package.json");
        fs.writeFile(
          pkgPath,
          JSON.stringify({
            name: "test-app",
            version: "1.0.0",
            scripts: { web: "expo start --web", start: "expo start" },
          })
        )
          .then(() => callback(null, "", ""))
          .catch((err) => callback(err as Error, "", ""));
      } else if (cmd.includes("npm install")) {
        callback(null, "", "");
      } else if (
        cmd.includes("expo install") &&
        cmd.includes("react-dom") &&
        cmd.includes("react-native-web")
      ) {
        if (expoInstallShouldFail) {
          callback(new Error("expo: command not found"), "", "expo: command not found");
        } else {
          callback(null, "", "");
        }
      } else {
        (
          actual.exec as (
            a: string,
            b: unknown,
            c: (err: Error | null, stdout?: string, stderr?: string) => void
          ) => void
        )(cmd, opts, callback);
      }
    },
  };
});

describe("ProjectService.scaffoldProject", () => {
  let projectService: ProjectService;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-scaffold-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("scaffolds web-app-expo-react and returns project details", async () => {
    const result = await projectService.scaffoldProject({
      name: "my-app",
      parentPath: tempDir,
      template: "web-app-expo-react",
      simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
    });

    expect(result.project).toBeDefined();
    expect(result.project.id).toBeDefined();
    expect(result.project.name).toBe("my-app");
    expect(result.project.repoPath).toBe(path.resolve(tempDir));
    expect(result.recovery).toBeUndefined();

    const repoPath = path.resolve(tempDir);
    const pkgPath = path.join(repoPath, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
    expect(pkg.scripts.web).toBe("expo start --web");
  });

  it("rejects missing name", async () => {
    await expect(
      projectService.scaffoldProject({
        name: "",
        parentPath: tempDir,
        template: "web-app-expo-react",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Project name is required" });
  });

  it("rejects missing parentPath", async () => {
    await expect(
      projectService.scaffoldProject({
        name: "my-app",
        parentPath: "",
        template: "web-app-expo-react",
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Project folder (parentPath) is required",
    });
  });

  it("rejects unsupported template", async () => {
    await expect(
      projectService.scaffoldProject({
        name: "my-app",
        parentPath: tempDir,
        template: "other-template" as "web-app-expo-react",
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Unsupported template"),
    });
  });

  it("uses default agent config when not provided", async () => {
    const result = await projectService.scaffoldProject({
      name: "default-agents",
      parentPath: tempDir,
      template: "web-app-expo-react",
    });

    expect(result.project).toBeDefined();
    expect(result.project.name).toBe("default-agents");
  });

  it("surfaces clear error when expo install step fails", async () => {
    expoInstallShouldFail = true;
    try {
      const err = await projectService
        .scaffoldProject({
          name: "expo-fail",
          parentPath: tempDir,
          template: "web-app-expo-react",
        })
        .catch((e) => e);
      expect(err).toMatchObject({ code: "SCAFFOLD_INIT_FAILED" });
      expect(err.message).toContain("Expo web dependencies could not be installed");
      expect(err.message).toContain("expo: command not found");
      expect(err.message).toContain("Ensure Expo CLI is available");
    } finally {
      expoInstallShouldFail = false;
    }
  });

  it("surfaces clear error when git is missing", async () => {
    gitCheckShouldFail = true;
    try {
      const err = await projectService
        .scaffoldProject({
          name: "no-git",
          parentPath: tempDir,
          template: "web-app-expo-react",
        })
        .catch((e) => e);
      expect(err).toMatchObject({ code: "SCAFFOLD_PREREQUISITES_MISSING" });
      expect(err.message).toContain("Git");
      expect(err.message).toContain("not installed");
      expect(err.message).toContain("https://git-scm.com/");
      expect(err.message).toContain("PATH");
    } finally {
      gitCheckShouldFail = false;
    }
  });

  it("surfaces clear error when node is missing", async () => {
    nodeCheckShouldFail = true;
    try {
      const err = await projectService
        .scaffoldProject({
          name: "no-node",
          parentPath: tempDir,
          template: "web-app-expo-react",
        })
        .catch((e) => e);
      expect(err).toMatchObject({ code: "SCAFFOLD_PREREQUISITES_MISSING" });
      expect(err.message).toContain("Node.js");
      expect(err.message).toContain("not installed");
      expect(err.message).toContain("https://nodejs.org/");
      expect(err.message).toContain("PATH");
    } finally {
      nodeCheckShouldFail = false;
    }
  });

  it("surfaces clear error when both git and node are missing", async () => {
    gitCheckShouldFail = true;
    nodeCheckShouldFail = true;
    try {
      const err = await projectService
        .scaffoldProject({
          name: "no-tools",
          parentPath: tempDir,
          template: "web-app-expo-react",
        })
        .catch((e) => e);
      expect(err).toMatchObject({ code: "SCAFFOLD_PREREQUISITES_MISSING" });
      expect(err.message).toContain("Git");
      expect(err.message).toContain("Node.js");
      expect(err.message).toContain("https://git-scm.com/");
      expect(err.message).toContain("https://nodejs.org/");
    } finally {
      gitCheckShouldFail = false;
      nodeCheckShouldFail = false;
    }
  });
});
