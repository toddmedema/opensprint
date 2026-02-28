import { describe, it, expect } from "vitest";
import {
  getTestCommandForFramework,
  resolveTestCommand,
  getAgentName,
  getAgentNameForRole,
  isAgentAssignee,
  isBlockedByTechnicalError,
  TECHNICAL_BLOCK_REASONS,
  AUTO_RETRY_BLOCKED_INTERVAL_MS,
} from "../constants/index.js";

describe("getTestCommandForFramework", () => {
  it("returns empty string for null", () => {
    expect(getTestCommandForFramework(null)).toBe("");
  });

  it("returns empty string for none", () => {
    expect(getTestCommandForFramework("none")).toBe("");
  });

  it("returns command for known framework", () => {
    expect(getTestCommandForFramework("jest")).toBe("npm test");
    expect(getTestCommandForFramework("vitest")).toBe("npx vitest run");
  });
});

describe("resolveTestCommand", () => {
  it("returns testCommand when set", () => {
    expect(resolveTestCommand({ testCommand: "pytest", testFramework: null })).toBe("pytest");
  });

  it("returns framework command when testCommand not set", () => {
    expect(resolveTestCommand({ testCommand: null, testFramework: "vitest" })).toBe(
      "npx vitest run"
    );
  });

  it("returns npm test when neither set", () => {
    expect(resolveTestCommand({ testCommand: null, testFramework: null })).toBe("npm test");
  });

  it("returns npm test when framework is none", () => {
    expect(resolveTestCommand({ testCommand: null, testFramework: "none" })).toBe("npm test");
  });
});

describe("getAgentName", () => {
  it("returns Frodo for slot 0", () => {
    expect(getAgentName(0)).toBe("Frodo");
  });
  it("returns Samwise for slot 1", () => {
    expect(getAgentName(1)).toBe("Samwise");
  });
  it("wraps with modulo (slot 13 → Frodo)", () => {
    expect(getAgentName(13)).toBe("Frodo");
  });
});

describe("getAgentNameForRole", () => {
  it("returns role-specific names", () => {
    expect(getAgentNameForRole("coder", 0)).toBe("Frodo");
    expect(getAgentNameForRole("reviewer", 0)).toBe("Boromir");
    expect(getAgentNameForRole("dreamer", 0)).toBe("Gandalf");
  });
  it("wraps with modulo", () => {
    expect(getAgentNameForRole("reviewer", 5)).toBe(getAgentNameForRole("reviewer", 0));
  });
  it("falls back to coder list for unknown role", () => {
    expect(getAgentNameForRole("unknown", 0)).toBe("Frodo");
  });
});

describe("isAgentAssignee", () => {
  it("returns true for known agent names", () => {
    expect(isAgentAssignee("Frodo")).toBe(true);
    expect(isAgentAssignee("Boromir")).toBe(true);
  });
  it("returns false for agent-N pattern", () => {
    expect(isAgentAssignee("agent-1")).toBe(false);
  });
  it("returns false for null/undefined/empty", () => {
    expect(isAgentAssignee(null)).toBe(false);
    expect(isAgentAssignee(undefined)).toBe(false);
    expect(isAgentAssignee("")).toBe(false);
  });
});

describe("isBlockedByTechnicalError", () => {
  it("returns true for Merge Failure and Coding Failure", () => {
    expect(isBlockedByTechnicalError("Merge Failure")).toBe(true);
    expect(isBlockedByTechnicalError("Coding Failure")).toBe(true);
  });
  it("returns false for human-feedback block reasons", () => {
    expect(isBlockedByTechnicalError("Open Question")).toBe(false);
    expect(isBlockedByTechnicalError("API Blocked")).toBe(false);
    expect(isBlockedByTechnicalError("Waiting for Human")).toBe(false);
  });
  it("returns false for null/undefined/empty", () => {
    expect(isBlockedByTechnicalError(null)).toBe(false);
    expect(isBlockedByTechnicalError(undefined)).toBe(false);
    expect(isBlockedByTechnicalError("")).toBe(false);
  });
});

describe("TECHNICAL_BLOCK_REASONS and AUTO_RETRY_BLOCKED_INTERVAL_MS", () => {
  it("TECHNICAL_BLOCK_REASONS includes Merge Failure and Coding Failure", () => {
    expect(TECHNICAL_BLOCK_REASONS).toContain("Merge Failure");
    expect(TECHNICAL_BLOCK_REASONS).toContain("Coding Failure");
  });
  it("AUTO_RETRY_BLOCKED_INTERVAL_MS is 8 hours", () => {
    expect(AUTO_RETRY_BLOCKED_INTERVAL_MS).toBe(8 * 60 * 60 * 1000);
  });
});
