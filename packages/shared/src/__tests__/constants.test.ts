import { describe, expect, it } from "vitest";
import {
  AGENT_NAMES_BY_ROLE,
  AUTO_RETRY_BLOCKED_INTERVAL_MS,
  COMMIT_MESSAGE_TITLE_MAX_LENGTH,
  TECHNICAL_BLOCK_REASONS,
  getAgentName,
  getAgentNameForRole,
  getTestCommandForFramework,
  isAgentAssignee,
  isBlockedByTechnicalError,
  resolveTestCommand,
} from "../constants/index.js";

describe("COMMIT_MESSAGE_TITLE_MAX_LENGTH", () => {
  it("is 45 for commit message / task title display truncation", () => {
    expect(COMMIT_MESSAGE_TITLE_MAX_LENGTH).toBe(45);
  });
});

describe("getTestCommandForFramework", () => {
  it.each([
    { framework: null, expected: "" },
    { framework: "none" as const, expected: "" },
    { framework: "jest" as const, expected: "npm test" },
    { framework: "vitest" as const, expected: "node ./node_modules/vitest/vitest.mjs run" },
  ])("returns $expected for $framework", ({ framework, expected }) => {
    expect(getTestCommandForFramework(framework)).toBe(expected);
  });
});

describe("resolveTestCommand", () => {
  it.each([
    {
      project: { testCommand: "pytest", testFramework: null },
      expected: "pytest",
    },
    {
      project: { testCommand: null, testFramework: "vitest" as const },
      expected: "node ./node_modules/vitest/vitest.mjs run",
    },
    {
      project: { testCommand: null, testFramework: null },
      expected: "npm test",
    },
    {
      project: { testCommand: null, testFramework: "none" as const },
      expected: "npm test",
    },
  ])("resolves $expected", ({ project, expected }) => {
    expect(resolveTestCommand(project)).toBe(expected);
  });
});

describe("agent naming", () => {
  it.each([
    { slot: 0, expected: "Frodo" },
    { slot: 1, expected: "Samwise" },
    { slot: 13, expected: "Frodo" },
  ])("maps slot $slot to $expected", ({ slot, expected }) => {
    expect(getAgentName(slot)).toBe(expected);
  });

  it.each([
    { role: "coder", slot: 0, expected: "Frodo" },
    { role: "reviewer", slot: 0, expected: "Boromir" },
    { role: "dreamer", slot: 0, expected: "Gandalf" },
  ] as const)("maps $role slot $slot to $expected", ({ role, slot, expected }) => {
    expect(getAgentNameForRole(role, slot)).toBe(expected);
  });

  it("wraps role-specific names by modulo", () => {
    const reviewerCount = AGENT_NAMES_BY_ROLE.reviewer.length;
    expect(getAgentNameForRole("reviewer", reviewerCount)).toBe(getAgentNameForRole("reviewer", 0));
  });

  it("falls back to the coder pool for unknown roles", () => {
    expect(getAgentNameForRole("unknown", 0)).toBe("Frodo");
  });
});

describe("isAgentAssignee", () => {
  it.each([
    { assignee: "Frodo", expected: true },
    { assignee: "Boromir", expected: true },
    { assignee: "agent-1", expected: false },
    { assignee: null, expected: false },
    { assignee: undefined, expected: false },
    { assignee: "", expected: false },
  ])("returns $expected for $assignee", ({ assignee, expected }) => {
    expect(isAgentAssignee(assignee)).toBe(expected);
  });
});

describe("isBlockedByTechnicalError", () => {
  it.each([
    { reason: "Merge Failure", expected: true },
    { reason: "Coding Failure", expected: true },
    { reason: "Open Question", expected: false },
    { reason: "API Blocked", expected: false },
    { reason: "Waiting for Human", expected: false },
    { reason: null, expected: false },
    { reason: undefined, expected: false },
    { reason: "", expected: false },
  ])("returns $expected for $reason", ({ reason, expected }) => {
    expect(isBlockedByTechnicalError(reason)).toBe(expected);
  });
});

describe("technical block constants", () => {
  it("keep the known technical reasons", () => {
    expect(TECHNICAL_BLOCK_REASONS).toContain("Merge Failure");
    expect(TECHNICAL_BLOCK_REASONS).toContain("Coding Failure");
  });

  it("uses an eight-hour blocked retry interval", () => {
    expect(AUTO_RETRY_BLOCKED_INTERVAL_MS).toBe(8 * 60 * 60 * 1000);
  });
});
