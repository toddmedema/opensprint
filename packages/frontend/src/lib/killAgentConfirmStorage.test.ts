import { describe, it, expect, beforeEach } from "vitest";
import {
  getKillAgentConfirmDisabled,
  setKillAgentConfirmDisabled,
  KILL_AGENT_CONFIRM_STORAGE_KEY,
} from "./killAgentConfirmStorage";

describe("killAgentConfirmStorage", () => {
  beforeEach(() => {
    localStorage.removeItem(KILL_AGENT_CONFIRM_STORAGE_KEY);
  });

  it("returns false when preference is not set", () => {
    expect(getKillAgentConfirmDisabled()).toBe(false);
  });

  it("returns false when preference is explicitly false", () => {
    localStorage.setItem(KILL_AGENT_CONFIRM_STORAGE_KEY, "false");
    expect(getKillAgentConfirmDisabled()).toBe(false);
  });

  it("returns true when preference is true", () => {
    localStorage.setItem(KILL_AGENT_CONFIRM_STORAGE_KEY, "true");
    expect(getKillAgentConfirmDisabled()).toBe(true);
  });

  it("persists preference when set to true", () => {
    setKillAgentConfirmDisabled(true);
    expect(localStorage.getItem(KILL_AGENT_CONFIRM_STORAGE_KEY)).toBe("true");
    expect(getKillAgentConfirmDisabled()).toBe(true);
  });

  it("persists preference when set to false", () => {
    setKillAgentConfirmDisabled(true);
    setKillAgentConfirmDisabled(false);
    expect(localStorage.getItem(KILL_AGENT_CONFIRM_STORAGE_KEY)).toBe("false");
    expect(getKillAgentConfirmDisabled()).toBe(false);
  });
});
