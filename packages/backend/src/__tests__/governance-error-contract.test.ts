import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import request from "supertest";
import type { Request } from "express";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { authorizedGovernanceActor } from "../middleware/governance-auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  GOVERNANCE_INVALID_INPUT,
  GOVERNANCE_STALE_VERSION,
  governanceError,
} from "../services/policy-context.js";

const governance = vi.hoisted(() => ({
  getActiveReleaseId: vi.fn(),
  createRelease: vi.fn(),
  audit: vi.fn(),
  withPublicationLock: vi.fn(),
  readSourceHashes: vi.fn(async () => ({})),
}));
vi.mock("../services/governance.service.js", () => ({ governanceService: governance }));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn(async () => "synthetic instructions"),
}));
vi.mock("../services/governance-source-hashes.js", () => ({
  readGovernanceSourceHashes: vi.fn(async () => ({})),
  governanceSourceDrift: vi.fn(() => []),
  resolveGovernanceSensitiveSourcePaths: vi.fn(async () => []),
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

const capture = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
};

// These sites used to be classified by matching their message text; each now names its code, and
// the message-driven cases here were replaced so that rewording a message cannot change a contract.
describe("governance error classification", () => {
  it("does not read meaning out of a message", () => {
    expect(capture(() => governanceError("Reload before approving; this is stale."))).toMatchObject(
      {
        code: "GOVERNANCE_CONFLICT",
        statusCode: 409,
      }
    );
    expect(capture(() => governanceError("Invalid: a rationale is required."))).toMatchObject({
      code: "GOVERNANCE_CONFLICT",
      statusCode: 409,
    });
  });
  it("gives invalid input its 400 and stale versions their 409", () => {
    expect(capture(() => governanceError("Bad", GOVERNANCE_INVALID_INPUT))).toMatchObject({
      code: "GOVERNANCE_INVALID_INPUT",
      statusCode: 400,
    });
    expect(capture(() => governanceError("Old", GOVERNANCE_STALE_VERSION))).toMatchObject({
      code: "GOVERNANCE_STALE_VERSION",
      statusCode: 409,
    });
  });
  it("keeps other conflicts and explicit codes unchanged", () => {
    expect(
      capture(() => governanceError("Late judge result cannot change this case."))
    ).toMatchObject({ code: "GOVERNANCE_CONFLICT", statusCode: 409 });
    expect(
      capture(() => governanceError("This ruling is bound to stale code.", "GOVERNANCE_STALE_CODE"))
    ).toMatchObject({ code: "GOVERNANCE_STALE_CODE", statusCode: 409 });
  });
});

describe("governance capability failures", () => {
  const secret = "synthetic-secret-".repeat(3);
  const failure = (supplied?: string) =>
    capture(() => authorizedGovernanceActor({ get: () => supplied } as unknown as Request));
  afterEach(() => vi.unstubAllEnvs());
  it("distinguishes unconfigured authority from a missing or incorrect capability", () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "");
    expect(failure("anything")).toMatchObject({
      code: "GOVERNANCE_HUMAN_REQUIRED",
      details: { reason: "not_configured" },
    });
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", secret);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Owner");
    expect(failure()).toMatchObject({ details: { reason: "missing" } });
    expect(failure("wrong")).toMatchObject({ details: { reason: "incorrect" } });
  });
});

describe("POST /governance/releases", () => {
  const secret = "synthetic-secret-".repeat(3);
  let repoPath: string;
  let app: express.Express;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath }).toString();
  const publish = (body: Record<string, unknown>) =>
    request(app)
      .post("/projects/proj-1/governance/releases")
      .set("x-opensprint-governance-capability", secret)
      .send({ rules: [], instructions: {}, ...body });

  beforeAll(async () => {
    repoPath = mkdtempSync(join(tmpdir(), "governance-release-route-"));
    git("init", "-q");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x"
    );
    const { createGovernanceRouter } = await import("../routes/governance.js");
    app = express();
    app.use(express.json());
    app.use(
      "/projects/:projectId/governance",
      createGovernanceRouter({
        getProject: vi.fn(async () => ({ repoPath })),
        getSettings: vi.fn(),
      } as never)
    );
    app.use(errorHandler);
  });
  afterAll(() => rmSync(repoPath, { recursive: true, force: true }));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", secret);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Owner");
    governance.withPublicationLock.mockImplementation(
      async (_project: string, fn: (assertLease: () => Promise<void>) => Promise<unknown>) =>
        fn(async () => {})
    );
    governance.getActiveReleaseId.mockResolvedValue(null);
    governance.createRelease.mockResolvedValue({ id: "release-new" });
  });
  afterEach(() => vi.unstubAllEnvs());

  // The rationale and staleness check moved into createRelease's transaction; the store tests prove
  // them atomic, so here the route only has to hand them over.
  it("hands the human rationale to the transaction that stages the release", async () => {
    const response = await publish({ expectedActiveReleaseId: null, rationale: " Approved " });
    expect(response.status).toBe(201);
    expect(governance.createRelease.mock.calls[0]?.[1]).toMatchObject({
      publication: { rationale: " Approved ", expectedActiveReleaseId: null },
    });
  });
  it.each([
    ["non-string revision", { enforcementRevision: 7 }],
    ["string instructions", { instructions: "abc" }],
    ["non-text instructions", { instructions: { coder: 1 } }],
    ["non-array rules", { rules: "abc" }],
  ])("answers a %s with a 400", async (_name, body) => {
    const response = await publish({ expectedActiveReleaseId: null, rationale: "Yes", ...body });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("GOVERNANCE_INVALID_INPUT");
    expect(governance.createRelease).not.toHaveBeenCalled();
  });
  it("requires a rationale and an explicit expected release", async () => {
    expect((await publish({ expectedActiveReleaseId: null })).status).toBe(400);
    expect((await publish({ rationale: "Approved" })).status).toBe(400);
    expect(governance.createRelease).not.toHaveBeenCalled();
  });
});
