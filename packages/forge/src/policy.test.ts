import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_PROMPT } from "./domain.js";
import { judgeAppeal } from "./gate/judge.js";
import { isBlockedPath, pathMatches, redactDiff } from "./integrate/blocked.js";
import { acquireProcessLock } from "./lock.js";
import { redactText } from "./redact.js";
import { hasRole } from "./identity/roles.js";
import { classifyVerifyEvidence, decidePatrol, decideVerifyFailure } from "./run/run-policy.js";
import { gradeCommands, probeCommands, validateRunbook } from "./runbook/runbook.js";
import { normalizeReplay } from "./evolve/replay.js";

const command = { argv: ["make", "verify"], cwd: ".", timeoutSec: 60 };

describe("runbook contract", () => {
  it("rejects shell binaries, escaping cwd, and a ship slot", () => {
    expect(() => validateRunbook(doc({ gates: [gate({ argv: ["bash", "-c", "true"] })] }))).toThrow(
      /bash/
    );
    expect(() => validateRunbook(doc({ gates: [gate({ cwd: "../" })] }))).toThrow(/cwd/);
    expect(() => validateRunbook(doc({ ship: { argv: ["make", "ship"] } }))).toThrow(/ship/);
    expect(() => validateRunbook(doc({ gates: [gate({ timeoutSec: 1201 })] }))).toThrow(/timeoutSec/);
  });

  it("grades only required gates and never invents npm", () => {
    const document = validateRunbook(
      doc({
        install: { argv: ["make", "deps"], cwd: ".", timeoutSec: 60 },
        gates: [gate({ id: "verify" }), gate({ id: "optional", argv: ["npm", "test"], required: false })],
      })
    );
    expect(probeCommands(document).map((item) => item.argv.join(" "))).toEqual([
      "make deps",
      "make verify",
    ]);
    expect(gradeCommands(document).map((item) => item.argv[0])).toEqual(["make"]);
    expect(JSON.stringify(gradeCommands(document))).not.toContain("npm");
  });

  it("keeps the platform prompt short", () => {
    expect(PLATFORM_PROMPT.length).toBeLessThanOrEqual(1024);
  });
});

describe("run policy", () => {
  it("follows the recovery table", () => {
    expect(
      decidePatrol({
        humanOwned: true,
        heartbeatFresh: false,
        pidAlive: false,
        ownsProcess: false,
        resultPresent: true,
        retryCount: 0,
        state: "running",
      }).type
    ).toBe("leave");
    expect(
      decidePatrol({
        humanOwned: false,
        heartbeatFresh: false,
        pidAlive: false,
        ownsProcess: false,
        resultPresent: true,
        retryCount: 0,
        state: "running",
      }).type
    ).toBe("complete_from_result");
    expect(
      decidePatrol({
        humanOwned: false,
        heartbeatFresh: false,
        pidAlive: false,
        ownsProcess: false,
        resultPresent: false,
        retryCount: 0,
        state: "running",
      }).type
    ).toBe("retry_once");
    expect(
      decidePatrol({
        humanOwned: false,
        heartbeatFresh: true,
        pidAlive: false,
        ownsProcess: false,
        resultPresent: false,
        retryCount: 0,
        state: "running",
      }).type
    ).toBe("leave");
  });

  it("retries code failures twice and heals a missing tool once", () => {
    expect(
      decideVerifyFailure({
        kind: "code",
        verifyHealCount: 0,
        codeRetryCount: 1,
        hasInstall: false,
        hasTools: false,
      })
    ).toBe("retry_worker");
    expect(
      decideVerifyFailure({
        kind: "code",
        verifyHealCount: 0,
        codeRetryCount: 2,
        hasInstall: false,
        hasTools: false,
      })
    ).toBe("hold");
    expect(
      decideVerifyFailure({
        kind: "deps",
        verifyHealCount: 0,
        codeRetryCount: 0,
        hasInstall: true,
        hasTools: false,
      })
    ).toBe("heal_install");
    expect(classifyVerifyEvidence([{ command: "make", exitCode: 127, excerpt: "not found" }])).toBe(
      "deps"
    );
  });
});

describe("gate and evolve guards", () => {
  it("does not let the judge dismiss concrete evidence", () => {
    const judgment = judgeAppeal(
      { kind: "standard", evidence: "routes/oauth/token.ts" },
      { alternatives: "skip", evidence: "please", risks: "none", limits: "once" }
    );
    expect(judgment.decision).toBe("uphold");
  });

  it("treats placeholder replay metrics as incomplete", () => {
    const normalized = normalizeReplay({
      imageDigest: "sha256:abc",
      network: "none",
      isolation: "docker",
      originalInputsPresent: true,
      heldOut: [{ name: "held", passed: true }],
      metrics: { placeholder: true },
      missing: [],
      note: "",
    });
    expect(normalized.status).toBe("incomplete");
  });
});

describe("safety helpers", () => {
  it("redacts secrets and blocked diffs", () => {
    expect(redactText("token=super-secret-token", ["super-secret-token"])).toContain("[redacted]");
    expect(redactDiff("diff --git a/.env b/.env\n+SECRET=1\n", [".env"])).toContain("[redacted]");
    expect(isBlockedPath("routes/oauth/token.ts", [])).toBe(true);
    expect(pathMatches("KEEP_OUT.txt", "KEEP_OUT.txt")).toBe(true);
  });

  it("accumulates roles and refuses a second server lock", () => {
    expect(hasRole("steer", "discuss")).toBe(true);
    expect(hasRole("view", "steer")).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lock-"));
    const release = acquireProcessLock(dir);
    expect(() => acquireProcessLock(dir)).toThrow(/already holds/);
    release();
    const again = acquireProcessLock(dir);
    again();
  });
});

function gate(overrides: Record<string, unknown> = {}) {
  return { id: "verify", required: true, ...command, ...overrides };
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    install: null,
    health: null,
    gates: [gate()],
    ship: null,
    runtimeTools: ["make"],
    dependencyPaths: ["Makefile"],
    blockedPaths: [".env"],
    ...overrides,
  };
}
