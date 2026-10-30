import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectSettings } from "@opensprint/shared";
import { getGlobalSettings } from "../services/global-settings.service.js";
import { detectTestFramework } from "../services/test-framework.service.js";
import {
  deleteSettingsFromStore,
  getRawSettingsRecord,
  setSettingsInStore,
  setSettingsStorePathForTesting,
  transformRawSettingsInStore,
  updateSettingsInStore,
} from "../services/settings-store.service.js";
import { runUpdateSettingsFlow } from "../services/project/project-settings-update-flow.js";
import {
  loadProjectSettingsFromStore,
  recordValidationDurationInStore,
} from "../services/project/project-settings-load.js";
import { buildDefaultSettings } from "../services/project/project-settings-helpers.js";
import { projectSettingsFromRaw } from "../services/project/project-settings-from-raw.js";
import { resetGlobalAgentConcurrencyForTests } from "../services/agent-global-concurrency.service.js";

vi.mock("../services/global-settings.service.js", () => ({ getGlobalSettings: vi.fn() }));
vi.mock("../services/test-framework.service.js", () => ({ detectTestFramework: vi.fn() }));

function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { gate, started, release, entered };
}

describe("atomic raw project settings transformations", () => {
  let directory: string;
  let storePath: string;
  const globalDefaults = {
    simpleComplexityAgent: {
      type: "claude-cli" as const,
      model: "global-simple",
      cliCommand: null,
    },
    complexComplexityAgent: {
      type: "claude-cli" as const,
      model: "global-complex",
      cliCommand: null,
    },
  };
  const inherited: Record<string, unknown> = {
    gitWorkingMode: "worktree",
    mergeStrategy: "per_task",
    deployment: { mode: "custom", customCommand: "npm run deploy" },
  };
  const deps = {
    getRepoPath: async () => directory,
    getSettingsWithRuntimeState: async (projectId: string) =>
      projectSettingsFromRaw(await getRawSettingsRecord(projectId), globalDefaults),
  };
  const disk = async () =>
    JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { settings: Record<string, unknown>; revision: number }
    >;
  const expectInherited = (raw: Record<string, unknown>) => {
    for (const key of [
      "simpleComplexityAgent",
      "complexComplexityAgent",
      "lowComplexityAgent",
      "highComplexityAgent",
    ])
      expect(raw).not.toHaveProperty(key);
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-atomic-settings-"));
    storePath = path.join(directory, "settings.json");
    setSettingsStorePathForTesting(storePath);
    vi.mocked(getGlobalSettings).mockReset().mockResolvedValue(globalDefaults);
    vi.mocked(detectTestFramework).mockReset().mockResolvedValue(null);
  });
  afterEach(async () => {
    resetGlobalAgentConcurrencyForTests();
    setSettingsStorePathForTesting(null);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("reapplies an HTTP patch to the latest settings after async work while preserving background state", async () => {
    await setSettingsInStore("A", inherited as unknown as ProjectSettings);
    const pending = barrier();
    vi.mocked(getGlobalSettings).mockImplementationOnce(async () => {
      pending.entered();
      await pending.gate;
      return globalDefaults;
    });
    const first = runUpdateSettingsFlow(deps, "A", {
      mergeStrategy: "per_epic",
      deployment: { webhookUrl: "https://example.test/new-hook" },
      simpleComplexityAgent: null,
    });
    await pending.started;
    await recordValidationDurationInStore("A", "scoped", 1234);
    await updateSettingsInStore("A", buildDefaultSettings(), (current) => ({
      ...current,
      selfImprovementLastRunAt: "2026-10-20T12:00:00.000Z",
      selfImprovementLastCommitSha: "new-commit",
    }));
    await runUpdateSettingsFlow(deps, "A", {
      autoExecutePlans: true,
      deployment: { customCommand: "npm run updated-deploy" },
    });
    pending.release();
    await first;
    const raw = await getRawSettingsRecord("A");
    expect(raw).toMatchObject({
      mergeStrategy: "per_epic",
      autoExecutePlans: true,
      selfImprovementLastRunAt: "2026-10-20T12:00:00.000Z",
      selfImprovementLastCommitSha: "new-commit",
      validationTimingProfile: { scoped: [1234] },
      deployment: {
        customCommand: "npm run updated-deploy",
        webhookUrl: "https://example.test/new-hook",
      },
    });
    expectInherited(raw);
    expect((await disk()).A.revision).toBe(5);
  });

  it("does not let delayed default detection overwrite a concurrently initialized project", async () => {
    const pending = barrier();
    vi.mocked(detectTestFramework).mockImplementationOnce(async () => {
      pending.entered();
      await pending.gate;
      return null;
    });
    const loading = loadProjectSettingsFromStore("A", directory);
    await pending.started;
    await runUpdateSettingsFlow(deps, "A", { mergeStrategy: "per_epic", autoExecutePlans: true });
    await recordValidationDurationInStore("A", "full", 5678);
    pending.release();
    const loaded = await loading;
    expect(loaded.mergeStrategy).toBe("per_epic");
    expect(loaded.autoExecutePlans).toBe(true);
    expect(loaded.validationTimingProfile?.full).toEqual([5678]);
    expectInherited(await getRawSettingsRecord("A"));
    expect((await disk()).A.revision).toBe(2);
  });

  it("keeps inherited agent tiers absent across timing updates, other-project writes, and deletes", async () => {
    await setSettingsInStore("A", inherited as unknown as ProjectSettings);
    await setSettingsInStore("B", inherited as unknown as ProjectSettings);
    await Promise.all([
      recordValidationDurationInStore("A", "scoped", 100),
      recordValidationDurationInStore("A", "scoped", 200),
      updateSettingsInStore("B", buildDefaultSettings(), (current) => ({
        ...current,
        autoExecutePlans: true,
      })),
    ]);
    expectInherited(await getRawSettingsRecord("A"));
    expectInherited(await getRawSettingsRecord("B"));
    expect((await disk()).A.revision).toBe(3);
    await deleteSettingsFromStore("B");
    expectInherited(await getRawSettingsRecord("A"));
    expect((await disk()).A.revision).toBe(3);
    expect(await getRawSettingsRecord("B")).toEqual({});
  });

  it("keeps explicit agent overrides and supports updater deletions without materializing inherited tiers", async () => {
    const agent = { type: "cursor", model: "explicit", cliCommand: null };
    await setSettingsInStore("A", {
      ...inherited,
      simpleComplexityAgent: agent,
      selfImprovementPendingCandidateId: "candidate",
    } as unknown as ProjectSettings);
    await updateSettingsInStore("A", buildDefaultSettings(), (current) => ({
      ...current,
      selfImprovementPendingCandidateId: undefined,
    }));
    const raw = await getRawSettingsRecord("A");
    expect(raw.simpleComplexityAgent).toEqual(agent);
    expect(raw).not.toHaveProperty("complexComplexityAgent");
    expect(raw).not.toHaveProperty("selfImprovementPendingCandidateId");
  });

  it("uses caller defaults for a missing entry without converting default agents into project overrides", async () => {
    const defaults = {
      ...buildDefaultSettings(),
      testFramework: "jest",
      gitWorkingMode: "branches" as const,
    };
    await updateSettingsInStore("A", defaults, (current) => ({
      ...current,
      autoExecutePlans: true,
    }));
    const raw = await getRawSettingsRecord("A");
    expect(raw).toMatchObject({
      testFramework: "jest",
      gitWorkingMode: "branches",
      autoExecutePlans: true,
    });
    expectInherited(raw);
  });

  it("leaves revision and contents unchanged after failed validation and allows subsequent writes", async () => {
    await setSettingsInStore("A", inherited as unknown as ProjectSettings);
    const before = await fs.readFile(storePath, "utf-8");
    await expect(
      runUpdateSettingsFlow(deps, "A", { maxTotalConcurrentAgents: 0 })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await fs.readFile(storePath, "utf-8")).toBe(before);
    const result = await transformRawSettingsInStore("A", (current, metadata) => {
      expect(metadata).toEqual({ exists: true, revision: 1 });
      return { ...current, autoExecutePlans: true };
    });
    expect(result.revision).toBe(2);
  });

  it("rejects writes over a corrupt store without losing its contents or poisoning the lock", async () => {
    await fs.writeFile(storePath, "{incomplete");
    await expect(
      setSettingsInStore("A", inherited as unknown as ProjectSettings)
    ).rejects.toThrow();
    expect(await fs.readFile(storePath, "utf-8")).toBe("{incomplete");
    await fs.writeFile(storePath, "{}");
    await setSettingsInStore("A", inherited as unknown as ProjectSettings);
    expect((await disk()).A.revision).toBe(1);
  });
});
