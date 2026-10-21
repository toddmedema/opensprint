import { setSettingsStorePathForTesting } from "../services/settings-store.service.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { DEFAULT_HIL_CONFIG, type ProjectSettings } from "@opensprint/shared";
import {
  getSettingsFromStore,
  getSettingsWithMetaFromStore,
  setSettingsInStore,
  updateSettingsInStore,
  deleteSettingsFromStore,
} from "../services/settings-store.service.js";
import {
  acquireGlobalAgentSlot,
  resetGlobalAgentConcurrencyForTests,
} from "../services/agent-global-concurrency.service.js";

function makeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
    deployment: { mode: "custom" },
    hilConfig: DEFAULT_HIL_CONFIG,
    testFramework: "vitest",
    gitWorkingMode: "worktree",
    ...overrides,
  };
}

describe("settings-store.service", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    resetGlobalAgentConcurrencyForTests();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-settings-store-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    setSettingsStorePathForTesting(path.join(tempHome, ".opensprint", "settings.json"));
  });

  afterEach(async () => {
    resetGlobalAgentConcurrencyForTests();
    setSettingsStorePathForTesting(null);
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("normalizes legacy raw settings entries and strips project apiKeys", async () => {
    const storePath = path.join(tempHome, ".opensprint", "settings.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "proj-1": {
            ...makeSettings(),
            apiKeys: { ANTHROPIC_API_KEY: [{ id: "old", value: "secret" }] },
          },
        },
        null,
        2
      )
    );

    const result = await getSettingsWithMetaFromStore(
      "proj-1",
      makeSettings({ testFramework: null })
    );
    expect(result.settings).not.toHaveProperty("apiKeys");
    expect(result.settings.testFramework).toBe("vitest");
    expect(result.updatedAt).toBeTruthy();
  });

  it("persists settings without apiKeys", async () => {
    const settings = makeSettings({
      apiKeys: { ANTHROPIC_API_KEY: [{ id: "k1", value: "secret" }] },
    } as Partial<ProjectSettings>);

    await setSettingsInStore("proj-1", settings);
    const loaded = await getSettingsFromStore("proj-1", makeSettings({ testFramework: null }));

    expect(loaded).not.toHaveProperty("apiKeys");
  });

  it("serializes concurrent updates for the same project", async () => {
    await setSettingsInStore("proj-1", makeSettings());

    const first = updateSettingsInStore("proj-1", makeSettings(), (current) => {
      return { ...current, gitWorkingMode: "branches" };
    });
    const second = updateSettingsInStore("proj-1", makeSettings(), (current) => ({
      ...current,
      testFramework: null,
    }));

    await Promise.all([first, second]);

    const loaded = await getSettingsFromStore("proj-1", makeSettings());
    expect(loaded.gitWorkingMode).toBe("branches");
    expect(loaded.testFramework).toBeNull();
  });

  it("serializes concurrent writes across different projects", async () => {
    await Promise.all([
      setSettingsInStore("proj-a", makeSettings({ testFramework: "vitest" })),
      setSettingsInStore("proj-b", makeSettings({ testFramework: "jest" })),
    ]);

    await Promise.all([
      updateSettingsInStore("proj-a", makeSettings(), (current) => ({
        ...current,
        mergeStrategy: "per_epic",
      })),
      updateSettingsInStore("proj-b", makeSettings(), (current) => ({
        ...current,
        unknownScopeStrategy: "conservative",
      })),
    ]);

    const [a, b] = await Promise.all([
      getSettingsFromStore("proj-a", makeSettings()),
      getSettingsFromStore("proj-b", makeSettings()),
    ]);
    expect(a.mergeStrategy).toBe("per_epic");
    expect(a.testFramework).toBe("vitest");
    expect(b.unknownScopeStrategy).toBe("conservative");
    expect(b.testFramework).toBe("jest");
  });

  it("deletes stored settings for a project", async () => {
    await setSettingsInStore("proj-1", makeSettings());
    await deleteSettingsFromStore("proj-1");

    await expect(
      getSettingsWithMetaFromStore("proj-1", makeSettings({ testFramework: null }))
    ).resolves.toEqual({
      settings: makeSettings({ testFramework: null }),
      updatedAt: null,
      revision: 0,
    });
  });

  it.each(["increase", "remove"])(
    "wakes queued agent admission when settings %s the cap",
    async (mode) => {
      await setSettingsInStore("resize-project", makeSettings({ maxTotalConcurrentAgents: 1 }));
      const first = await acquireGlobalAgentSlot("resize-project");
      const queued = acquireGlobalAgentSlot("resize-project");
      if (mode === "increase") {
        await updateSettingsInStore("resize-project", makeSettings(), (settings) => ({
          ...settings,
          maxTotalConcurrentAgents: 2,
        }));
      } else {
        await deleteSettingsFromStore("resize-project");
      }
      const releaseQueued = await queued;
      first();
      releaseQueued();
    }
  );
});
