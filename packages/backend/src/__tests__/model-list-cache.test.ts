import { describe, it, expect, beforeEach } from "vitest";
import * as modelListCache from "../services/model-list-cache.js";

describe("model-list-cache", () => {
  beforeEach(() => {
    modelListCache.clear();
  });

  it("returns undefined for missing key", () => {
    expect(modelListCache.get("missing")).toBeUndefined();
  });

  it("returns value immediately after set", () => {
    const value = [{ id: "claude-1", displayName: "Claude 1" }];
    modelListCache.set("claude", value);
    expect(modelListCache.get("claude")).toEqual(value);
  });

  it("returns undefined after TTL expires", async () => {
    const value = [{ id: "claude-1", displayName: "Claude 1" }];
    modelListCache.set("claude", value, 50); // 50ms TTL
    expect(modelListCache.get("claude")).toEqual(value);

    await new Promise((r) => setTimeout(r, 60));
    expect(modelListCache.get("claude")).toBeUndefined();
  });

  it("clears all entries", () => {
    modelListCache.set("claude", []);
    modelListCache.set("cursor", []);
    modelListCache.clear();
    expect(modelListCache.get("claude")).toBeUndefined();
    expect(modelListCache.get("cursor")).toBeUndefined();
  });

  it("isolates keys", () => {
    const claudeModels = [{ id: "c1", displayName: "Claude" }];
    const cursorModels = [{ id: "cur1", displayName: "Cursor" }];
    modelListCache.set("claude", claudeModels);
    modelListCache.set("cursor", cursorModels);
    expect(modelListCache.get("claude")).toEqual(claudeModels);
    expect(modelListCache.get("cursor")).toEqual(cursorModels);
  });
});
